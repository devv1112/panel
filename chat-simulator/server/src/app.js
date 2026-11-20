/**
 * @file HTTP edge: validation, security headers, CORS, local abuse limits,
 * and the browser-facing SSE stream. No Coarena key ever reaches the browser.
 */

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ValidationError } from "./errors.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { sseFrame } from "./sse.js";

const MAX_BODY_BYTES = 1024 * 1024;
const CSP =
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self'";

/** @type {Record<string, string>} */
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

/**
 * @param {import("node:http").ServerResponse} res
 * @param {boolean} [isHtml]
 */
function securityHeaders(res, isHtml = false) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (isHtml) res.setHeader("Content-Security-Policy", CSP);
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
}

/** @param {unknown} error */
function serializeError(error) {
    if (error && typeof error.toJSON === "function") return error.toJSON();
    const e = error instanceof Error ? error : new Error(String(error));
    return {
        kind: "server",
        code: e.name || "INTERNAL_ERROR",
        message: e.message,
        httpStatus: e.status || 500,
    };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<unknown>}
 */
async function readJson(req) {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new ValidationError(`Request body exceeds ${MAX_BODY_BYTES} bytes.`, 413);
        chunks.push(chunk);
    }
    if (size === 0) throw new ValidationError("A JSON body is required.");
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new ValidationError("Request body is not valid JSON.");
    }
}

/**
 * @param {unknown} body
 */
function validateChat(body) {
    if (!body || typeof body !== "object") throw new ValidationError("Body must be an object.");
    const input = /** @type {Record<string, any>} */ (body);
    if (typeof input.model !== "string" || !input.model.trim()) {
        throw new ValidationError("model must be an id returned by GET /api/models.");
    }
    if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 200) {
        throw new ValidationError("messages must contain between 1 and 200 entries.");
    }
    const messages = input.messages.map((message) => {
        if (!message || !["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string") {
            throw new ValidationError("Each message needs a role of user/assistant/system and string content.");
        }
        if (message.content.length > 20_000) throw new ValidationError("A message cannot exceed 20,000 characters.");
        return { role: message.role, content: message.content };
    });
    let maxTokens;
    if (input.maxTokens !== undefined) {
        maxTokens = Number(input.maxTokens);
        if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16_384) {
            throw new ValidationError("maxTokens must be an integer between 1 and 16,384 (Coarena's documented maximum).");
        }
    }
    return { model: input.model.trim(), messages, maxTokens };
}

/**
 * Build the local HTTP server.
 *
 * @param {import("./config.js").AppConfig} config
 * @param {import("./coarena-client.js").CoarenaClient} client
 * @returns {import("node:http").Server}
 */
export function createApp(config, client) {
    const clientLimiter = new SlidingWindowLimiter(config.clientRpm, 60_000);

    const server = http.createServer((req, res) => {
        void handle(req, res).catch((error) => {
            if (res.headersSent) {
                res.end();
            } else {
                sendJson(res, error instanceof ValidationError ? error.status : 500, {
                    error: serializeError(error),
                });
            }
            if (!(error instanceof ValidationError)) console.error("[chat-simulator]", serializeError(error));
        });
    });

    /**
     * @param {import("node:http").IncomingMessage} req
     * @param {import("node:http").ServerResponse} res
     */
    async function handle(req, res) {
        const url = new URL(req.url || "/", "http://localhost");
        const isApi = url.pathname.startsWith("/api/");
        securityHeaders(res, !isApi);
        res.setHeader("Cache-Control", "no-store");

        if (isApi) {
            const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
            const corsAllowed = Boolean(config.allowedOrigin && origin === config.allowedOrigin);
            if (corsAllowed) {
                res.setHeader("Access-Control-Allow-Origin", /** @type {string} */ (origin));
                res.setHeader("Vary", "Origin");
                res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                res.setHeader("Access-Control-Allow-Headers", "content-type, x-app-token");
                res.setHeader("Access-Control-Max-Age", "600");
            }
            if (req.method === "OPTIONS") {
                if (corsAllowed) {
                    res.writeHead(204);
                    res.end();
                } else {
                    sendJson(res, 403, { error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not in APP_ALLOWED_ORIGIN." } });
                }
                return;
            }
            if (!config.allowedOrigin && origin) {
                // Same-origin deployment: an explicit browser origin without CORS
                // configuration is refused instead of silently widening access.
                res.setHeader("Vary", "Origin");
            }

            if (config.accessToken) {
                const supplied = String(req.headers["x-app-token"] || "");
                const a = Buffer.from(supplied);
                const b = Buffer.from(config.accessToken);
                if (a.length !== b.length || !timingSafeEqual(a, b)) {
                    sendJson(res, 401, { error: { kind: "auth", code: "INVALID_APP_TOKEN", message: "Invalid x-app-token." } });
                    return;
                }
            }

            const ip = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
            if (!clientLimiter.reserve(ip)) {
                sendJson(res, 429, {
                    error: {
                        kind: "local",
                        code: "LOCAL_RATE_LIMIT",
                        message: `Local limit of ${config.clientRpm} requests/minute per client reached.`,
                        retryable: true,
                        retryAfterMs: clientLimiter.waitMs(ip),
                    },
                });
                return;
            }

            switch (url.pathname) {
                case "/api/health":
                    sendJson(res, 200, {
                        status: "ok",
                        upstream: config.baseUrl.href,
                        keyConfigured: true,
                        modelSource: "GET /models",
                    });
                    return;
                case "/api/models":
                    sendJson(res, 200, await client.getModels({ force: url.searchParams.get("refresh") === "1" }));
                    return;
                case "/api/limits":
                    sendJson(res, 200, await client.getLimits());
                    return;
                case "/api/chat":
                    if (req.method !== "POST") {
                        sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } });
                        return;
                    }
                    await handleChat(req, res);
                    return;
                case "/api/feedback": {
                    if (req.method !== "POST") {
                        sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use POST." } });
                        return;
                    }
                    const body = /** @type {Record<string, any>} */ (await readJson(req));
                    const result = await client.sendFeedback({
                        requestId: String(body.requestId || ""),
                        rating: String(body.rating || ""),
                        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
                        note: typeof body.note === "string" ? body.note : undefined,
                    });
                    sendJson(res, 200, { ok: true, upstream: result });
                    return;
                }
                default:
                    sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No route for ${url.pathname}.` } });
                    return;
            }
        }

        await serveStatic(url.pathname, res);
    }

    /**
     * @param {import("node:http").IncomingMessage} req
     * @param {import("node:http").ServerResponse} res
     */
    async function handleChat(req, res) {
        const input = validateChat(await readJson(req));
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        const controller = new AbortController();
        res.on("close", () => {
            if (!res.writableFinished) controller.abort();
        });
        res.write(sseFrame("status", { phase: "accepted", model: input.model, at: new Date().toISOString() }));

        try {
            await client.streamChat({ ...input, signal: controller.signal }, (event) => {
                if (!res.destroyed) res.write(sseFrame(String(event.type), event));
            });
        } catch (error) {
            if (!res.destroyed) res.write(sseFrame("error", { error: serializeError(error) }));
        } finally {
            if (!res.destroyed) res.end();
        }
    }

    /**
     * @param {string} pathname
     * @param {import("node:http").ServerResponse} res
     */
    async function serveStatic(pathname, res) {
        if (!config.staticDir) {
            sendJson(res, 404, { error: { code: "NO_STATIC_BUILD", message: "web/dist is not built yet." } });
            return;
        }
        const root = path.resolve(config.staticDir);
        const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
        const target = path.resolve(root, `.${requested}`);
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
            sendJson(res, 403, { error: { code: "FORBIDDEN", message: "Path traversal refused." } });
            return;
        }
        let file = target;
        try {
            const info = await stat(file);
            if (info.isDirectory()) file = path.join(file, "index.html");
        } catch {
            file = path.join(root, "index.html"); // SPA fallback
        }
        try {
            const content = await readFile(file);
            const ext = path.extname(file).toLowerCase();
            securityHeaders(res, ext === ".html");
            res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": content.length });
            res.end(content);
        } catch {
            sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Build the React app into web/dist first." } });
        }
    }

    return server;
}
