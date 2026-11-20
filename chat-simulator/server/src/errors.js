/**
 * @file Error types derived from real upstream responses, never from canned chat text.
 */

/**
 * Convert `Retry-After` (delta-seconds or HTTP-date) into milliseconds.
 *
 * @param {string | null} raw
 * @param {number} [now]
 * @returns {number | null}
 */
export function parseRetryAfter(raw, now = Date.now()) {
    if (!raw) return null;
    const seconds = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
    if (seconds !== null) return Math.max(0, Math.min(seconds * 1_000, 300_000));
    const date = Date.parse(raw);
    if (Number.isNaN(date)) return null;
    return Math.max(0, Math.min(date - now, 300_000));
}

/**
 * A refusal returned by Coarena, or a local transport failure with the same
 * technical shape. `message` comes from the upstream body when it exists.
 */
export class UpstreamError extends Error {
    /**
     * @param {object} options
     * @param {number} options.status - Real HTTP status (200 when an error was embedded in a committed stream).
     * @param {string} options.code - Real `error.code` / `code` from the response, or a local transport code.
     * @param {string} [options.type]
     * @param {string} options.message - Real `error.message` when the provider supplied one.
     * @param {string | null} [options.requestId]
     * @param {number | null} [options.retryAfterMs]
     * @param {boolean} [options.shouldRetry]
     * @param {unknown} [options.limitIncrease] - Real `error.limit_increase` on quota 429s.
     * @param {Record<string, string>} [options.headers]
     * @param {unknown} [options.responseBody]
     */
    constructor({
        status,
        code,
        type = null,
        message,
        requestId = null,
        retryAfterMs = null,
        shouldRetry = true,
        limitIncrease = null,
        headers = {},
        responseBody = null,
    }) {
        const detail = message || `${code} (HTTP ${status})`;
        super(`${code} · HTTP ${status}${requestId ? ` · request=${requestId}` : ""}: ${detail}`);
        this.name = "UpstreamError";
        this.status = status;
        this.code = code;
        this.type = type;
        this.detail = detail;
        this.requestId = requestId;
        this.retryAfterMs = retryAfterMs;
        this.shouldRetry = shouldRetry;
        this.limitIncrease = limitIncrease;
        this.headers = headers;
        this.responseBody = responseBody;
    }

    /** @returns {boolean} */
    get retryable() {
        if (this.shouldRetry === false) return false;
        if (this.status === 429) {
            return ["rate_limit_exceeded", "concurrency_limit_exceeded"].includes(this.code);
        }
        return [502, 503, 504].includes(this.status);
    }

    /** @returns {Record<string, unknown>} */
    toJSON() {
        return {
            kind: "upstream",
            code: this.code,
            type: this.type,
            httpStatus: this.status,
            message: this.detail,
            requestId: this.requestId,
            retryable: this.retryable,
            retryAfterMs: this.retryAfterMs,
            limitIncrease: this.limitIncrease,
        };
    }
}

/**
 * A 200 response whose SSE stream did not complete according to the
 * documented OpenAI-compatible contract (`data: [DONE]` + finish_reason).
 * Coarena commits HTTP 200 after 20 seconds and pads long answers with
 * newlines, so a late upstream error can only be detected here.
 */
export class IncompleteStreamError extends Error {
    /** @param {Record<string, unknown>} evidence */
    constructor(evidence) {
        const { code = "INCOMPLETE_STREAM", requestId, doneSeen, finishReason, chunks, bytes, elapsedMs } = evidence;
        super(
            `${code}${requestId ? ` · request=${requestId}` : ""}: upstream stream ended without a complete ` +
                `Chat Completions exchange (done=${String(doneSeen)}, finish_reason=${String(finishReason)}, ` +
                `chunks=${String(chunks)}, bytes=${String(bytes)}, elapsed_ms=${String(elapsedMs)}).`,
        );
        this.name = "IncompleteStreamError";
        this.evidence = evidence;
    }

    /** @returns {Record<string, unknown>} */
    toJSON() {
        return { kind: "incomplete_stream", code: "INCOMPLETE_STREAM", message: this.message, ...this.evidence };
    }
}

/** A bad request from the browser; no upstream call is made. */
export class ValidationError extends Error {
    /** @param {string} message @param {number} [status] */
    constructor(message, status = 400) {
        super(message);
        this.name = "ValidationError";
        this.status = status;
    }
}

/**
 * @param {Record<string, any>} headers
 * @returns {string | null}
 */
export function headerRequestId(headers) {
    return headers["x-coarena-request-id"] || headers["request-id"] || null;
}

/**
 * Read an OpenAI-envelope error from a real HTTP response.
 *
 * @param {number} status
 * @param {unknown} body
 * @param {Headers} headers
 * @returns {UpstreamError}
 */
export function readOpenAIError(status, body, headers) {
    const envelope = body && typeof body === "object" ? body : {};
    const error = envelope.error && typeof envelope.error === "object" ? envelope.error : {};
    const code =
        error.code ||
        (typeof envelope.code === "string" ? envelope.code : null) ||
        `HTTP_${status}`;
    const message = error.message || (typeof envelope.message === "string" ? envelope.message : null);
    const headerBag = Object.fromEntries(headers.entries());
    return new UpstreamError({
        status,
        code: String(code),
        type: typeof error.type === "string" ? error.type : null,
        message: message || `Coarena answered HTTP ${status} without an error message.`,
        requestId: headerRequestId(headerBag),
        retryAfterMs: parseRetryAfter(headers.get("retry-after")),
        shouldRetry: headers.get("x-should-retry") !== "false",
        limitIncrease: error.limit_increase ?? envelope.limit_increase ?? null,
        headers: headerBag,
        responseBody: body,
    });
}
