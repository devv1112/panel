/**
 * @file Explicit configuration for the Coarena chat simulator proxy.
 *
 * Nothing about the upstream contract is guessed here. The two values that
 * must come from the operator are the key and the base URL; every other
 * number is either a documented Coarena limit or a local safety setting, and
 * is visible in `.env.example`.
 *
 * Upstream facts (verified against https://coarena.ai/developers and
 * https://coarena.ai/api/openapi.json on 2026-11-19):
 *   - 30 requests/minute per key, per account and per account+model.
 *   - 2 concurrent model calls per account.
 *   - 128,000 input tokens, 8 MiB request body, 16,384 output tokens max.
 */

/**
 * @typedef {object} AppConfig
 * @property {string} apiKey - Real personal key, `coa_…`, with `inference:write`.
 * @property {URL} baseUrl - OpenAI-compatible base URL, e.g. https://coarena.ai/api/v1/.
 * @property {string} host - Interface the HTTP server binds to.
 * @property {number} port - Local HTTP port.
 * @property {string} staticDir - Absolute path of the built React application.
 * @property {string | null} allowedOrigin - Exact browser origin allowed by CORS in dev.
 * @property {string | null} accessToken - Optional shared-secret header for a public deployment.
 * @property {number} clientRpm - Requests/minute allowed per browser IP on this proxy.
 * @property {number} keyRpm - Upstream requests/minute budget (documented: 30).
 * @property {number} maxConcurrency - Upstream concurrent calls (documented: 2).
 * @property {number} timeoutMs - Wall clock budget for a single upstream attempt.
 * @property {number} maxAttempts - Total attempts for retryable upstream failures.
 * @property {number} backoffBaseMs - First exponential-backoff step.
 * @property {number} backoffMaxMs - Upper bound of a computed backoff step.
 * @property {number} modelCacheTtlMs - How long the live `/models` list is reused.
 */

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string}
 */
function required(env, name) {
    const value = env[name]?.trim();
    if (!value) {
        throw new Error(
            `Missing required environment variable ${name}. ` +
                "Copy server/.env.example to server/.env and fill it with values from your Coarena account.",
        );
    }
    return value;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} documentedValue
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function number(env, name, documentedValue, bounds = {}) {
    const raw = env[name]?.trim();
    const parsed = raw === undefined || raw === "" ? documentedValue : Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a number, received ${JSON.stringify(raw)}.`);
    }
    if (bounds.min !== undefined && parsed < bounds.min) {
        throw new Error(`${name} must be >= ${bounds.min}, received ${parsed}.`);
    }
    if (bounds.max !== undefined && parsed > bounds.max) {
        throw new Error(`${name} must be <= ${bounds.max}, received ${parsed}.`);
    }
    return parsed;
}

/**
 * Load and validate the process environment.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {AppConfig}
 */
export function loadConfig(env = process.env) {
    const apiKey = required(env, "COARENA_API_KEY");
    if (!apiKey.startsWith("coa_")) {
        throw new Error("COARENA_API_KEY must be the real coa_… token from https://coarena.ai/account/api/keys.");
    }

    const baseUrl = new URL(required(env, "COARENA_BASE_URL"));
    if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1") {
        throw new Error("COARENA_BASE_URL must use HTTPS (localhost is allowed for tests).");
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;

    return {
        apiKey,
        baseUrl,
        host: env.APP_HOST?.trim() || "127.0.0.1",
        port: number(env, "APP_PORT", 8787, { min: 1, max: 65535 }),
        staticDir: "",
        allowedOrigin: env.APP_ALLOWED_ORIGIN?.trim() || null,
        accessToken: env.APP_ACCESS_TOKEN?.trim() || null,
        clientRpm: number(env, "APP_CLIENT_RPM", 20, { min: 1 }),
        keyRpm: number(env, "COARENA_KEY_RPM", 30, { min: 1 }),
        maxConcurrency: number(env, "COARENA_MAX_CONCURRENCY", 2, { min: 1 }),
        timeoutMs: number(env, "COARENA_TIMEOUT_MS", 180_000, { min: 1_000 }),
        maxAttempts: number(env, "COARENA_MAX_ATTEMPTS", 4, { min: 1, max: 8 }),
        backoffBaseMs: number(env, "COARENA_BACKOFF_BASE_MS", 400, { min: 1 }),
        backoffMaxMs: number(env, "COARENA_BACKOFF_MAX_MS", 8_000, { min: 1 }),
        modelCacheTtlMs: number(env, "MODEL_CACHE_TTL_MS", 600_000, { min: 0 }),
    };
}

/**
 * @param {AppConfig} config
 * @param {string} staticDir
 * @returns {AppConfig}
 */
export function withStaticDir(config, staticDir) {
    return { ...config, staticDir };
}
