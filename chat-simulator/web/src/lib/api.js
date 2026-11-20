/**
 * @file Browser-side transport. All URLs are relative: in production the same
 * origin serves the React build and the key proxy; in dev Vite proxies `/api`.
 */

/** sessionStorage key for the optional shared secret (never localStorage). */
const TOKEN_KEY = "coarena-chat:app-token";

/** @returns {string} */
export function getAppToken() {
    try {
        return globalThis.sessionStorage?.getItem(TOKEN_KEY) || "";
    } catch {
        return "";
    }
}

/** @param {string} token */
export function setAppToken(token) {
    try {
        if (token) globalThis.sessionStorage?.setItem(TOKEN_KEY, token);
        else globalThis.sessionStorage?.removeItem(TOKEN_KEY);
    } catch {
        // Private browsing can block sessionStorage; the next request will 401.
    }
}

/**
 * @param {Record<string, string>} [headers]
 * @returns {Record<string, string>}
 */
function withToken(headers = {}) {
    const token = getAppToken();
    return token ? { ...headers, "x-app-token": token } : headers;
}

/** An error built from the real JSON envelope returned by the local proxy. */
export class ApiError extends Error {
    /**
     * @param {Record<string, any>} payload
     * @param {number} status
     */
    constructor(payload, status) {
        const error = payload?.error && typeof payload.error === "object" ? payload.error : payload;
        const code = String(error?.code || `HTTP_${status}`);
        const message = String(error?.message || `HTTP ${status}`);
        super(`${code} (HTTP ${status}): ${message}`);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
        this.detail = error;
    }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function jsonRequest(path, init) {
    const response = await fetch(path, {
        ...init,
        headers: withToken(/** @type {Record<string, string>} */ (init?.headers || {})),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(body, response.status);
    return body;
}

/** @returns {Promise<any>} */
export function getHealth() {
    return jsonRequest("/api/health");
}

/**
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<{ data: Array<{id: string, display_name?: string}>, fetchedAt: number, requestId: string | null, cacheHit: boolean }>}
 */
export function getModels({ refresh = false } = {}) {
    return jsonRequest(`/api/models${refresh ? "?refresh=1" : ""}`);
}

/** @returns {Promise<any>} */
export function getLimits() {
    return jsonRequest("/api/limits");
}

/**
 * @param {{ requestId: string, rating: string, tags?: string[], note?: string }} input
 * @returns {Promise<any>}
 */
export function sendFeedback(input) {
    return jsonRequest("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

/**
 * Consume a typed SSE stream from `/api/chat`.
 *
 * @param {{
 *   model: string,
 *   messages: Array<{role: string, content: string}>,
 *   maxTokens?: number,
 *   signal?: AbortSignal,
 *   onEvent: (event: { type: string, data: Record<string, any> }) => void
 * }} input
 * @returns {Promise<void>}
 */
export async function streamChat({ model, messages, maxTokens, signal, onEvent }) {
    const response = await fetch("/api/chat", {
        method: "POST",
        headers: withToken({ "Content-Type": "application/json" }),
        signal,
        body: JSON.stringify({ model, messages, ...(maxTokens ? { maxTokens } : {}) }),
    });
    if (!response.ok) throw new ApiError(await response.json().catch(() => ({})), response.status);
    if (!response.body) throw new ApiError({ error: { code: "NO_STREAM", message: "No response body from the local proxy." } }, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    /**
     * @param {string} raw
     */
    function consume(raw) {
        let type = "message";
        /** @type {string[]} */
        const data = [];
        for (const line of raw.split("\n")) {
            if (!line || line.startsWith(":")) continue;
            if (line.startsWith("event:")) type = line.slice(6).trim();
            if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) return;
        try {
            onEvent({ type, data: JSON.parse(data.join("\n")) });
        } catch {
            onEvent({ type: "malformed", data: { raw } });
        }
    }

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
            consume(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
        }
    }
    if (buffer.trim()) consume(buffer);
}
