/**
 * @file Thin, documented adapter for the Coarena Model API.
 *
 * It uses the OpenAI-compatible surface at `/api/v1`, keeps the key in the
 * server process, mirrors the documented rate limits locally, and validates
 * stream completion before telling the browser the answer is finished.
 */

import { IncompleteStreamError, UpstreamError, parseRetryAfter, readOpenAIError } from "./errors.js";
import { Semaphore, SlidingWindowLimiter, backoff, sleep } from "./rate-limit.js";
import { createSseParser } from "./sse.js";

/**
 * @typedef {object} ResponseMeta
 * @property {string | null} requestId - `x-coarena-request-id`, the id used for feedback.
 * @property {string | null} model - `x-coarena-model`, the model that actually answered.
 * @property {{ from: string | null, to: string | null, reason: string | null } | null} substitution
 * @property {string | null} droppedParams
 * @property {string | null} emulated
 * @property {Record<string, string>} rateLimit
 */

/**
 * Collect the real response headers Coarena sends on every Model API answer.
 *
 * @param {Headers} headers
 * @returns {ResponseMeta}
 */
export function readResponseMeta(headers) {
    const from = headers.get("x-coarena-substituted-from");
    const to = headers.get("x-coarena-substituted-to");
    const reason = headers.get("x-coarena-substitution-reason");
    /** @type {Record<string, string>} */
    const rateLimit = {};
    for (const [name, value] of headers.entries()) {
        if (name.startsWith("x-ratelimit-")) rateLimit[name] = value;
    }
    return {
        requestId: headers.get("x-coarena-request-id") || headers.get("request-id") || null,
        model: headers.get("x-coarena-model"),
        substitution: from || to || reason ? { from, to, reason } : null,
        droppedParams: headers.get("x-coarena-dropped-params"),
        emulated: headers.get("x-coarena-emulated"),
        rateLimit,
    };
}

/**
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function jsonOrUpstreamError(response) {
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // A non-JSON 200 is still reported with its real status and id.
    }
    if (body && typeof body === "object" && body.error) {
        throw readOpenAIError(response.status, body, response.headers);
    }
    return body;
}

export class CoarenaClient {
    /**
     * @param {import("./config.js").AppConfig} config
     * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps]
     */
    constructor(config, deps = {}) {
        this.config = config;
        this.fetchImpl = deps.fetchImpl || globalThis.fetch;
        this.now = deps.now || Date.now;
        this.limiter = new SlidingWindowLimiter(config.keyRpm, 60_000);
        this.semaphore = new Semaphore(config.maxConcurrency);
        /** @type {{ data: Array<{id: string, display_name?: string}>, fetchedAt: number, requestId: string | null } | null} */
        this.modelsCache = null;
    }

    /**
     * One authorized HTTP call with retry on real 429/5xx answers.
     *
     * @param {string} path - Relative to `COARENA_BASE_URL`.
     * @param {{ method?: string, body?: unknown, auth?: boolean, signal?: AbortSignal }} [options]
     * @returns {Promise<Response>}
     */
    async #request(path, { method = "GET", body, auth = true, signal } = {}) {
        const url = new URL(path.replace(/^\/+/, ""), this.config.baseUrl);
        const headers = { Accept: "application/json" };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (auth) headers.Authorization = `Bearer ${this.config.apiKey}`;

        for (let attempt = 1; ; attempt += 1) {
            const timeout = AbortSignal.timeout(this.config.timeoutMs);
            const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
            let response;
            try {
                response = await this.fetchImpl(url, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: activeSignal,
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                if (timeout.aborted) {
                    throw new UpstreamError({
                        status: 504,
                        code: "REQUEST_TIMEOUT",
                        message: `Upstream call exceeded ${this.config.timeoutMs} ms.`,
                        shouldRetry: false,
                    });
                }
                const transportError = new UpstreamError({
                    status: 502,
                    code: "TRANSPORT_ERROR",
                    message: String(error instanceof Error ? error.message : error),
                });
                if (!transportError.retryable || attempt >= this.config.maxAttempts) throw transportError;
                await sleep(backoff(attempt, this.config.backoffBaseMs, this.config.backoffMaxMs), activeSignal);
                continue;
            }

            if (response.ok) return response;

            const responseBody = await response.text().catch(() => "");
            let parsed = null;
            try {
                parsed = responseBody ? JSON.parse(responseBody) : null;
            } catch {
                // Keep the raw body for diagnostics.
            }
            const error = readOpenAIError(response.status, parsed || responseBody, response.headers);
            if (!error.retryable || attempt >= this.config.maxAttempts) throw error;
            const wait = error.retryAfterMs ?? backoff(attempt, this.config.backoffBaseMs, this.config.backoffMaxMs);
            await sleep(wait, activeSignal);
        }
    }

    /**
     * Reserve a rate-window slot and a concurrency slot around an upstream call.
     *
     * @template T
     * @param {AbortSignal | undefined} signal
     * @param {(waitMs: number) => void} [onWait]
     * @param {() => Promise<T>} task
     * @returns {Promise<T>}
     */
    async #withSlot(signal, onWait, task) {
        for (;;) {
            const wait = this.limiter.waitMs();
            if (wait === 0) break;
            onWait?.(wait);
            await sleep(wait, signal);
        }
        this.limiter.reserve();
        const release = await this.semaphore.acquire(signal);
        try {
            return await task();
        } finally {
            release();
        }
    }

    /**
     * The model list is public and changes over time; it is never hardcoded.
     *
     * @param {{ force?: boolean }} [options]
     * @returns {Promise<{ data: Array<{id: string, display_name?: string}>, fetchedAt: number, requestId: string | null, cacheHit: boolean, source: string }>}
     */
    async getModels({ force = false } = {}) {
        const cached = this.modelsCache;
        if (!force && cached && this.now() - cached.fetchedAt < this.config.modelCacheTtlMs) {
            return { ...cached, cacheHit: true, source: this.config.baseUrl.href };
        }
        const response = await this.#request("models", { auth: false });
        const body = await jsonOrUpstreamError(response);
        const models = Array.isArray(body?.data)
            ? body.data
                  .filter((item) => item && typeof item.id === "string")
                  .map((item) => ({ id: item.id, display_name: item.display_name || item.id }))
            : [];
        if (models.length === 0) {
            throw new UpstreamError({
                status: response.status,
                code: "INVALID_MODELS_RESPONSE",
                message: "GET /models returned no usable model ids.",
                requestId: readResponseMeta(response.headers).requestId,
                responseBody: body,
            });
        }
        this.modelsCache = { data: models, fetchedAt: this.now(), requestId: readResponseMeta(response.headers).requestId };
        return { ...this.modelsCache, cacheHit: false, source: this.config.baseUrl.href };
    }

    /**
     * Real usage/limit numbers for the key currently configured.
     *
     * @returns {Promise<unknown>}
     */
    async getLimits() {
        const response = await this.#request("limits");
        return jsonOrUpstreamError(response);
    }

    /**
     * Rate a reply using the real `x-coarena-request-id` from a completed stream.
     *
     * @param {{ requestId: string, rating: string, tags?: string[], note?: string }} input
     * @returns {Promise<unknown>}
     */
    async sendFeedback({ requestId, rating, tags, note }) {
        if (!requestId || !rating) throw new UpstreamError({ status: 400, code: "INVALID_FEEDBACK", message: "requestId and rating are required." });
        /** @type {Record<string, unknown>} */
        const body = { request_id: requestId, rating };
        if (Array.isArray(tags)) body.tags = tags;
        if (note !== undefined) body.note = note;
        const response = await this.#request("feedback", { method: "POST", body });
        return jsonOrUpstreamError(response);
    }

    /**
     * Stream a chat completion and emit typed events to the caller.
     *
     * A reply that passes 20 s gets HTTP 200 with newline padding, and a late
     * error can arrive in the body. Completion is therefore decided by the
     * `[DONE]` marker plus `finish_reason`, not by HTTP status alone.
     *
     * @param {{ model: string, messages: Array<{role: string, content: string}>, maxTokens?: number, signal?: AbortSignal }} input
     * @param {(event: Record<string, unknown>) => void} onEvent
     * @returns {Promise<{ completed: boolean }>}
     */
    async streamChat({ model, messages, maxTokens, signal }, onEvent) {
        /** @type {Record<string, unknown>} */
        const body = { model, messages, stream: true, stream_options: { include_usage: true } };
        if (Number.isInteger(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

        return this.#withSlot(
            signal,
            (wait) => onEvent({ type: "queued", waitMs: wait, reason: "local_rate_window" }),
            async () => {
                const response = await this.#request("chat/completions", { method: "POST", body, signal });
                const meta = readResponseMeta(response.headers);
                onEvent({ type: "opened", upstreamStatus: response.status, requestedModel: model, ...meta });

                const reader = response.body?.getReader();
                if (!reader) {
                    const error = new IncompleteStreamError({
                        requestId: meta.requestId,
                        doneSeen: false,
                        finishReason: null,
                        chunks: 0,
                        bytes: 0,
                        elapsedMs: 0,
                        reason: "no_response_body",
                    });
                    onEvent({ type: "error", error: error.toJSON() });
                    return { completed: false };
                }

                const contentType = response.headers.get("content-type") || "";
                if (!contentType.includes("text/event-stream")) {
                    const chunks = [];
                    const decoder = new TextDecoder();
                    for (;;) {
                        const part = await reader.read();
                        if (part.done) break;
                        chunks.push(decoder.decode(part.value, { stream: true }));
                    }
                    chunks.push(decoder.decode());
                    const payload = chunks.join("");
                    let parsed = null;
                    try {
                        parsed = payload ? JSON.parse(payload) : null;
                    } catch {
                        // Reported with the real content type below.
                    }
                    const error = parsed?.error
                        ? readOpenAIError(response.status, parsed, response.headers)
                        : new IncompleteStreamError({
                              requestId: meta.requestId,
                              doneSeen: false,
                              finishReason: null,
                              chunks: 0,
                              bytes: payload.length,
                              elapsedMs: 0,
                              reason: "unexpected_content_type",
                              contentType,
                          });
                    onEvent({ type: "error", error: "toJSON" in error ? error.toJSON() : error });
                    return { completed: false };
                }

                /** @type {any} */
                const state = {
                    doneSeen: false,
                    finishReason: null,
                    chunks: 0,
                    frames: 0,
                    bytes: 0,
                    malformedFrames: 0,
                    usage: null,
                    streamError: null,
                    readError: null,
                    firstFrameAt: null,
                    startedAt: this.now(),
                };

                const parser = createSseParser(({ data }) => {
                    state.frames += 1;
                    state.firstFrameAt ??= this.now();
                    if (data.trim() === "[DONE]") {
                        state.doneSeen = true;
                        return;
                    }
                    let payload;
                    try {
                        payload = JSON.parse(data);
                    } catch {
                        state.malformedFrames += 1;
                        return;
                    }
                    if (payload?.error) {
                        state.streamError = readOpenAIError(200, payload, response.headers);
                        return;
                    }
                    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
                    if (choice?.finish_reason) state.finishReason = choice.finish_reason;
                    if (payload?.usage) state.usage = payload.usage;
                    const delta = choice?.delta?.content;
                    if (typeof delta === "string" && delta.length > 0) {
                        state.chunks += 1;
                        onEvent({ type: "delta", text: delta, requestId: meta.requestId, answeredModel: meta.model });
                    }
                });

                const decoder = new TextDecoder();
                try {
                    for (;;) {
                        const part = await reader.read();
                        if (part.done) break;
                        state.bytes += part.value.byteLength;
                        parser.feed(decoder.decode(part.value, { stream: true }));
                    }
                    parser.feed(decoder.decode());
                    parser.end();
                } catch (error) {
                    if (signal?.aborted) throw error;
                    state.readError = String(error instanceof Error ? error.message : error);
                }

                const elapsedMs = this.now() - state.startedAt;
                /** @type {Record<string, unknown>} */
                const evidence = {
                    requestId: meta.requestId,
                    requestedModel: model,
                    answeredModel: meta.model,
                    substitution: meta.substitution,
                    droppedParams: meta.droppedParams,
                    upstreamStatus: response.status,
                    doneSeen: state.doneSeen,
                    finishReason: state.finishReason,
                    frames: state.frames,
                    chunks: state.chunks,
                    bytes: state.bytes,
                    malformedFrames: state.malformedFrames,
                    elapsedMs,
                    timeToFirstFrameMs: state.firstFrameAt === null ? null : state.firstFrameAt - state.startedAt,
                    readError: state.readError,
                    rateLimit: meta.rateLimit,
                };

                if (state.streamError) {
                    onEvent({ type: "error", error: { ...state.streamError.toJSON(), ...evidence } });
                    return { completed: false };
                }
                if (!state.doneSeen || !state.finishReason || state.malformedFrames > 0 || state.readError) {
                    const error = new IncompleteStreamError({ ...evidence, code: "INCOMPLETE_STREAM" });
                    onEvent({ type: "error", error: error.toJSON() });
                    return { completed: false };
                }
                if (["length", "content_filter"].includes(String(state.finishReason))) {
                    onEvent({
                        type: "warning",
                        warning: {
                            code: state.finishReason === "length" ? "OUTPUT_TRUNCATED" : "CONTENT_FILTERED",
                            finishReason: state.finishReason,
                            maxTokens: maxTokens ?? null,
                            requestId: meta.requestId,
                        },
                    });
                }
                onEvent({ type: "done", ...evidence, usage: state.usage });
                return { completed: true };
            },
        );
    }
}
