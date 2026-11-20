/**
 * @file LocalStorage cache for the chat simulator.
 *
 * Only conversation text, metadata and the live model list are cached.
 * The Coarena key, app tokens and streaming partials are NEVER written here.
 * Writes happen once a turn settles, not once per streamed token.
 */

export const SCHEMA = 1;
const PREFIX = `coarena-chat:v${SCHEMA}`;

/** @type {{ index: string, settings: string, models: string, conversation: (id: string) => string }} */
export const KEYS = {
    index: `${PREFIX}:index`,
    settings: `${PREFIX}:settings`,
    models: `${PREFIX}:models`,
    conversation: (id) => `${PREFIX}:c:${id}`,
};

/** Real browser storage budgets vary; stay well under the common 5 MiB limit. */
export const LIMITS = {
    maxConversations: 20,
    maxMessagesPerConversation: 200,
    maxConversationBytes: 500_000,
    maxTotalBytes: 1_500_000,
    conversationTtlMs: 14 * 24 * 60 * 60 * 1000,
    modelCacheTtlMs: 60 * 60 * 1000,
};

/** Typed storage failure; `code` is safe to display in the technical banner. */
export class StorageError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {Record<string, unknown>} [detail]
     */
    constructor(code, message, detail = {}) {
        super(`${code}: ${message}`);
        this.name = "StorageError";
        this.code = code;
        this.detail = detail;
    }
}

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {"user" | "assistant" | "system"} role
 * @property {string} content
 * @property {number} createdAt
 * @property {"ok" | "streaming" | "error"} [status]
 * @property {Record<string, unknown>} [error]
 * @property {string} [requestId]
 * @property {string} [model]
 * @property {unknown} [usage]
 * @property {string} [finishReason]
 * @property {string} [rating]
 */

/**
 * @typedef {object} Conversation
 * @property {string} id
 * @property {string} [title]
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} [model]
 * @property {ChatMessage[]} messages
 */

/**
 * @returns {Storage}
 */
function store() {
    const local = globalThis.localStorage;
    if (!local) throw new StorageError("STORAGE_UNAVAILABLE", "localStorage is disabled in this browser.");
    return local;
}

/** @param {unknown} error @returns {boolean} */
function isQuotaError(error) {
    return (
        error instanceof DOMException &&
        (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
    );
}

/** @param {string} value @returns {number} */
function byteLength(value) {
    return new TextEncoder().encode(value).length;
}

/**
 * @param {string} key
 * @returns {unknown}
 */
function parseKey(key) {
    const raw = store().getItem(key);
    if (raw === null) return null;
    try {
        return JSON.parse(raw);
    } catch (error) {
        store().removeItem(key);
        throw new StorageError("STORAGE_CORRUPT", `Cached key ${key} was unreadable and has been removed.`, {
            key,
            cause: String(error),
        });
    }
}

/** @param {string} id */
function assertId(id) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
        throw new StorageError("INVALID_CONVERSATION_ID", `Conversation id ${JSON.stringify(id)} is not allowed.`);
    }
}

/** @returns {Array<{id: string, title: string, createdAt: number, updatedAt: number, model?: string}>} */
function readIndex() {
    const value = parseKey(KEYS.index);
    if (value === null) return [];
    if (!Array.isArray(value)) {
        throw new StorageError("STORAGE_CORRUPT", "Conversation index has an unexpected shape.");
    }
    return value.filter(
        (item) => item && typeof item.id === "string" && typeof item.updatedAt === "number",
    );
}

/** @param {Array<unknown>} index */
function writeIndex(index) {
    store().setItem(KEYS.index, JSON.stringify(index));
}

/** @returns {number} */
function totalBytes() {
    const local = store();
    let total = 0;
    for (let i = 0; i < local.length; i += 1) {
        const key = local.key(i);
        if (key?.startsWith(PREFIX)) total += byteLength(key) + byteLength(local.getItem(key) || "");
    }
    return total;
}

/**
 * Remove expired conversations, then enforce the conversation cap and the
 * aggregate byte budget. Oldest-updated entries go first (LRU).
 *
 * @param {string} [protectedKey]
 */
function prune(protectedKey) {
    let index = readIndex();
    const now = Date.now();
    const survivors = [];
    for (const entry of index) {
        const expired = now - entry.updatedAt > LIMITS.conversationTtlMs;
        if (expired) {
            store().removeItem(KEYS.conversation(entry.id));
        } else {
            survivors.push(entry);
        }
    }
    index = survivors.sort((a, b) => b.updatedAt - a.updatedAt);
    if (index.length > LIMITS.maxConversations) {
        for (const entry of index.slice(LIMITS.maxConversations)) {
            store().removeItem(KEYS.conversation(entry.id));
        }
        index = index.slice(0, LIMITS.maxConversations);
    }
    writeIndex(index);

    while (totalBytes() > LIMITS.maxTotalBytes) {
        const oldest = index.find((entry) => KEYS.conversation(entry.id) !== protectedKey);
        if (!oldest) {
            if (store().getItem(KEYS.models) !== null) {
                store().removeItem(KEYS.models);
                continue;
            }
            throw new StorageError("STORAGE_QUOTA", "Local cache budget is full and nothing can be evicted.");
        }
        store().removeItem(KEYS.conversation(oldest.id));
        index = index.filter((entry) => entry.id !== oldest.id);
        writeIndex(index);
    }
}

/**
 * @param {string} key
 * @param {string} payload
 * @param {string} [protectedKey]
 */
function setWithQuota(key, payload, protectedKey) {
    try {
        store().setItem(key, payload);
        return;
    } catch (error) {
        if (!isQuotaError(error)) {
            throw new StorageError("STORAGE_WRITE_FAILED", "localStorage refused the write.", { key, cause: String(error) });
        }
    }
    for (let i = 0; i < LIMITS.maxConversations + 2; i += 1) {
        const index = readIndex().sort((a, b) => a.updatedAt - b.updatedAt);
        const victim = index.find((entry) => KEYS.conversation(entry.id) !== protectedKey && KEYS.conversation(entry.id) !== key);
        if (victim) {
            store().removeItem(KEYS.conversation(victim.id));
            writeIndex(index.filter((entry) => entry.id !== victim.id));
        } else if (store().getItem(KEYS.models) !== null && KEYS.models !== key) {
            store().removeItem(KEYS.models);
        } else {
            break;
        }
        try {
            store().setItem(key, payload);
            return;
        } catch (error) {
            if (!isQuotaError(error)) {
                throw new StorageError("STORAGE_WRITE_FAILED", "localStorage refused the write.", { key, cause: String(error) });
            }
        }
    }
    throw new StorageError("STORAGE_QUOTA", "Not enough localStorage space after evicting old conversations.", { key });
}

/**
 * @param {Conversation} conversation
 * @returns {Conversation}
 */
function sanitize(conversation) {
    if (!conversation || typeof conversation.id !== "string") {
        throw new StorageError("INVALID_CONVERSATION", "A conversation with an id is required.");
    }
    assertId(conversation.id);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    return {
        id: conversation.id,
        title: typeof conversation.title === "string" ? conversation.title.slice(0, 200) : undefined,
        createdAt: Number(conversation.createdAt) || Date.now(),
        updatedAt: Number(conversation.updatedAt) || Date.now(),
        model: typeof conversation.model === "string" ? conversation.model : undefined,
        messages: messages.slice(-LIMITS.maxMessagesPerConversation).map((message) => ({
            id: String(message.id),
            role: ["user", "assistant", "system"].includes(message.role) ? message.role : "user",
            content: String(message.content ?? ""),
            createdAt: Number(message.createdAt) || Date.now(),
            status: ["ok", "streaming", "error"].includes(message.status) ? message.status : "ok",
            requestId: message.requestId ? String(message.requestId) : undefined,
            model: message.model ? String(message.model) : undefined,
            usage: message.usage ?? undefined,
            finishReason: message.finishReason ? String(message.finishReason) : undefined,
            error: message.error ?? undefined,
        })),
    };
}

/** @param {Conversation} conversation */
export function saveConversation(conversation) {
    const clean = sanitize(conversation);
    const key = KEYS.conversation(clean.id);
    let payload = JSON.stringify(clean);
    while (byteLength(payload) > LIMITS.maxConversationBytes && clean.messages.length > 1) {
        clean.messages.shift();
        payload = JSON.stringify(clean);
    }
    setWithQuota(key, payload, key);
    const title =
        clean.title ||
        clean.messages.find((message) => message.role === "user")?.content.slice(0, 80) ||
        "New chat";
    const index = readIndex().filter((entry) => entry.id !== clean.id);
    index.push({ id: clean.id, title, createdAt: clean.createdAt, updatedAt: clean.updatedAt, model: clean.model });
    try {
        writeIndex(index);
        prune(key);
    } catch (error) {
        throw error instanceof StorageError ? error : new StorageError("STORAGE_WRITE_FAILED", String(error));
    }
}

/** @param {string} id @returns {Conversation | null} */
export function loadConversation(id) {
    assertId(id);
    const value = parseKey(KEYS.conversation(id));
    if (!value || !Array.isArray(value.messages)) return null;
    return /** @type {Conversation} */ (value);
}

/** @returns {Array<{id: string, title: string, updatedAt: number}>} */
export function listConversations() {
    return readIndex()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((entry) => ({ id: entry.id, title: entry.title, updatedAt: entry.updatedAt }));
}

/** @param {string} id */
export function deleteConversation(id) {
    assertId(id);
    store().removeItem(KEYS.conversation(id));
    writeIndex(readIndex().filter((entry) => entry.id !== id));
}

/** @returns {{ selectedModelId: string | null, activeId: string | null }} */
export function loadSettings() {
    const value = parseKey(KEYS.settings);
    if (!value || typeof value !== "object") return { selectedModelId: null, activeId: null };
    const settings = /** @type {Record<string, any>} */ (value);
    return {
        selectedModelId: typeof settings.selectedModelId === "string" ? settings.selectedModelId : null,
        activeId: typeof settings.activeId === "string" ? settings.activeId : null,
    };
}

/** @param {{ selectedModelId?: string | null, activeId?: string | null }} patch */
export function saveSettings(patch) {
    store().setItem(KEYS.settings, JSON.stringify({ ...loadSettings(), ...patch }));
}

/**
 * @param {Array<{id: string, display_name?: string}>} models
 */
export function cacheModels(models) {
    store().setItem(KEYS.models, JSON.stringify({ fetchedAt: Date.now(), models }));
}

/** @returns {Array<{id: string, display_name?: string}> | null} */
export function readModelCache() {
    const value = parseKey(KEYS.models);
    if (!value || typeof value !== "object") return null;
    const cache = /** @type {Record<string, any>} */ (value);
    if (Date.now() - Number(cache.fetchedAt) > LIMITS.modelCacheTtlMs || !Array.isArray(cache.models)) return null;
    return cache.models;
}
