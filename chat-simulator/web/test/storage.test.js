/** Tests for the LocalStorage cache using a quota-aware in-memory stub. */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    KEYS,
    LIMITS,
    StorageError,
    cacheModels,
    deleteConversation,
    listConversations,
    loadConversation,
    loadSettings,
    readModelCache,
    saveConversation,
    saveSettings,
} from "../src/lib/storage.js";

/** @param {number} [maxBytes] */
class MemoryStorage {
    constructor(maxBytes = Number.POSITIVE_INFINITY) {
        this.map = new Map();
        this.maxBytes = maxBytes;
    }
    get length() {
        return this.map.size;
    }
    /** @param {number} i */
    key(i) {
        return [...this.map.keys()][i] ?? null;
    }
    /** @param {string} key */
    getItem(key) {
        return this.map.has(key) ? /** @type {string} */ (this.map.get(key)) : null;
    }
    /** @param {string} key @param {string} value */
    setItem(key, value) {
        const text = String(value);
        let total = 0;
        for (const [k, v] of this.map) total += k.length + v.length;
        if (total + key.length + text.length > this.maxBytes) {
            throw new DOMException("storage full", "QuotaExceededError");
        }
        this.map.set(key, text);
    }
    /** @param {string} key */
    removeItem(key) {
        this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
}

beforeEach(() => {
    globalThis.localStorage = new MemoryStorage();
});

/** @param {string} id @param {number} offset @param {string} [content] */
function conversation(id, offset, content = "hello") {
    const now = Date.now() - offset;
    return {
        id,
        createdAt: now,
        updatedAt: now,
        messages: [{ id: `${id}-m1`, role: "user", content, createdAt: now, status: "ok" }],
    };
}

test("a conversation round-trips through the versioned key namespace", () => {
    saveConversation(conversation("abc123", 0));
    const loaded = loadConversation("abc123");
    assert.equal(loaded?.messages[0].content, "hello");
    assert.equal(listConversations()[0].id, "abc123");
    deleteConversation("abc123");
    assert.equal(loadConversation("abc123"), null);
});

test("the index keeps only the 20 most recently updated conversations", () => {
    for (let i = 0; i < LIMITS.maxConversations + 5; i += 1) {
        saveConversation(conversation(`c${i}`, (LIMITS.maxConversations + 5 - i) * 60_000));
    }
    const list = listConversations();
    assert.equal(list.length, LIMITS.maxConversations);
    assert.equal(globalThis.localStorage.getItem(KEYS.conversation("c0")), null);
    assert.notEqual(globalThis.localStorage.getItem(KEYS.conversation(`c${LIMITS.maxConversations + 4}`)), null);
});

test("a full localStorage evicts old entries before accepting a new one", () => {
    globalThis.localStorage = new MemoryStorage(6_000);
    const body = "x".repeat(1_600);
    saveConversation(conversation("older", 3_000, body));
    saveConversation(conversation("newer", 0, body));
    assert.ok(listConversations().some((entry) => entry.id === "newer"));
    assert.equal(listConversations().length <= 2, true);
});

test("unreadable cache entries raise a typed error and are removed", () => {
    globalThis.localStorage.setItem(KEYS.conversation("broken"), "{not json");
    assert.throws(
        () => loadConversation("broken"),
        (error) => error instanceof StorageError && error.code === "STORAGE_CORRUPT",
    );
    assert.equal(globalThis.localStorage.getItem(KEYS.conversation("broken")), null);
});

test("settings and the live model cache are versioned and expiring", () => {
    saveSettings({ selectedModelId: "claude-fable-5", activeId: "abc123" });
    assert.deepEqual(loadSettings(), { selectedModelId: "claude-fable-5", activeId: "abc123" });

    cacheModels([{ id: "claude-fable-5" }]);
    assert.equal(readModelCache()?.[0].id, "claude-fable-5");
    const cached = JSON.parse(/** @type {string} */ (globalThis.localStorage.getItem(KEYS.models)));
    cached.fetchedAt = Date.now() - LIMITS.modelCacheTtlMs - 1;
    globalThis.localStorage.setItem(KEYS.models, JSON.stringify(cached));
    assert.equal(readModelCache(), null);
});
