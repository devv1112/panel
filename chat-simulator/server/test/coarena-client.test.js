/**
 * Contract tests against a local fake of the documented Coarena surface.
 * No real key or network call is used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CoarenaClient } from "../src/coarena-client.js";

/**
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler
 * @param {(config: any, client: CoarenaClient) => Promise<void>} run
 */
async function withUpstream(handler, run) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    const config = {
        apiKey: "coa_test_only",
        baseUrl: new URL(`http://127.0.0.1:${port}/v1/`),
        keyRpm: 1000,
        maxConcurrency: 2,
        timeoutMs: 5_000,
        maxAttempts: 3,
        backoffBaseMs: 1,
        backoffMaxMs: 2,
        modelCacheTtlMs: 0,
        modelCache: null,
    };
    try {
        await run(config, new CoarenaClient(config));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

/** @param {unknown} payload */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = "data: [DONE]\n\n";

/** @param {Record<string, unknown>[]} events */
const typeOf = (events) => events.map((event) => event.type);

/**
 * @param {import("node:http").ServerResponse} res
 */
function streamHeaders(res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("x-coarena-request-id", "req_from_real_header");
    res.setHeader("x-coarena-model", "claude-fable-5");
    res.setHeader("x-coarena-substituted-from", "gpt-6-luna");
    res.setHeader("x-coarena-substituted-to", "claude-fable-5");
    res.setHeader("x-coarena-substitution-reason", "cost_routing");
    res.setHeader("x-ratelimit-remaining-requests", "28");
}

test("retries 429 using the real Retry-After header, then streams a reply", async () => {
    let attempts = 0;
    await withUpstream(
        (_req, res) => {
            attempts += 1;
            if (attempts === 1) {
                res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0", "x-coarena-request-id": "req_429" });
                res.end(
                    JSON.stringify({
                        error: {
                            type: "rate_limit_error",
                            code: "rate_limit_exceeded",
                            message: "Too many requests for this key.",
                        },
                    }),
                );
                return;
            }
            streamHeaders(res);
            res.end(frame({ choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] }) + DONE);
        },
        async (_config, client) => {
            /** @type {Record<string, any>[]} */
            const events = [];
            const result = await client.streamChat(
                { model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] },
                (event) => events.push(event),
            );
            assert.equal(attempts, 2);
            assert.equal(result.completed, true);
            assert.equal(typeOf(events).includes("error"), false);
            assert.equal(events.find((event) => event.type === "delta")?.text, "hello");
            assert.equal(events.find((event) => event.type === "done")?.requestId, "req_from_real_header");
            assert.equal(events.find((event) => event.type === "opened")?.substitution.reason, "cost_routing");
        },
    );
});

test("an OpenAI-envelope 401 is surfaced with its real code and is not retried", async () => {
    let attempts = 0;
    await withUpstream(
        (_req, res) => {
            attempts += 1;
            res.writeHead(401, { "Content-Type": "application/json", "x-coarena-request-id": "req_401" });
            res.end(
                JSON.stringify({
                    error: { type: "authentication_error", code: "invalid_api_key", message: "That API key is not valid." },
                }),
            );
        },
        async (_config, client) => {
            await assert.rejects(
                client.streamChat({ model: "any", messages: [{ role: "user", content: "hi" }] }, () => {}),
                (error) => {
                    assert.equal(error.name, "UpstreamError");
                    assert.equal(error.code, "invalid_api_key");
                    assert.match(error.message, /That API key is not valid/);
                    assert.equal(error.requestId, "req_401");
                    return true;
                },
            );
            assert.equal(attempts, 1);
        },
    );
});

test("a stream without [DONE] and finish_reason is reported as INCOMPLETE_STREAM", async () => {
    await withUpstream(
        (_req, res) => {
            streamHeaders(res);
            res.write(frame({ choices: [{ delta: { content: "partial" }, finish_reason: null }] }));
            // Keeps the 200 alive with padding, then closes without [DONE].
            res.write("\n\n");
            res.end();
        },
        async (_config, client) => {
            /** @type {Record<string, any>[]} */
            const events = [];
            const result = await client.streamChat(
                { model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] },
                (event) => events.push(event),
            );
            assert.equal(result.completed, false);
            const error = events.find((event) => event.type === "error")?.error;
            assert.equal(error.code, "INCOMPLETE_STREAM");
            assert.equal(error.doneSeen, false);
            assert.equal(error.finishReason, null);
            assert.equal(error.chunks, 1);
            assert.equal(error.requestId, "req_from_real_header");
            assert.equal(typeOf(events).includes("done"), false);
        },
    );
});

test("a late error in a committed stream is surfaced instead of a fake answer", async () => {
    await withUpstream(
        (_req, res) => {
            streamHeaders(res);
            res.write(frame({ choices: [{ delta: { content: "partial" }, finish_reason: null }] }));
            res.end(
                frame({
                    error: {
                        type: "server_error",
                        code: "upstream_timeout",
                        message: "The provider stopped answering.",
                    },
                }),
            );
        },
        async (_config, client) => {
            /** @type {Record<string, any>[]} */
            const events = [];
            const result = await client.streamChat(
                { model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] },
                (event) => events.push(event),
            );
            assert.equal(result.completed, false);
            const error = events.find((event) => event.type === "error")?.error;
            assert.equal(error.code, "upstream_timeout");
            assert.match(error.message, /provider stopped answering/);
        },
    );
});

test("finish_reason=length emits a technical truncation warning", async () => {
    await withUpstream(
        (_req, res) => {
            streamHeaders(res);
            res.end(frame({ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] }) + DONE);
        },
        async (_config, client) => {
            /** @type {Record<string, any>[]} */
            const events = [];
            const result = await client.streamChat(
                { model: "claude-fable-5", messages: [{ role: "user", content: "hi" }], maxTokens: 16 },
                (event) => events.push(event),
            );
            assert.equal(result.completed, true);
            const warning = events.find((event) => event.type === "warning")?.warning;
            assert.equal(warning.code, "OUTPUT_TRUNCATED");
            assert.equal(warning.maxTokens, 16);
        },
    );
});

test("model ids come from GET /models, never from a hardcoded list", async () => {
    await withUpstream(
        (req, res) => {
            assert.equal(req.url, "/v1/models");
            assert.equal(req.headers.authorization, undefined);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ object: "list", data: [{ id: "model-from-upstream", display_name: "Live Model" }] }));
        },
        async (_config, client) => {
            const result = await client.getModels();
            assert.deepEqual(result.data, [{ id: "model-from-upstream", display_name: "Live Model" }]);
            assert.equal(result.cacheHit, false);
        },
    );
});
