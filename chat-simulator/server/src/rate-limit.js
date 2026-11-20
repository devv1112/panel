/**
 * @file Local sliding-window limiter and concurrency semaphore.
 *
 * Coarena counts the trailing 60 seconds exactly, and allows 2 concurrent
 * model calls per account. We mirror both locally so ordinary UI behaviour
 * rarely turns into a real 429, while still honouring real 429s when they do.
 */

/** Sliding-window counter over an exact time window. */
export class SlidingWindowLimiter {
    /** @param {number} limit @param {number} windowMs */
    constructor(limit, windowMs = 60_000) {
        this.limit = limit;
        this.windowMs = windowMs;
        /** @type {Map<string, number[]>} */
        this.hits = new Map();
    }

    /**
     * Milliseconds until a slot is available (0 means available now).
     *
     * @param {string} key
     * @param {number} [now]
     * @returns {number}
     */
    waitMs(key = "default", now = Date.now()) {
        const hits = (this.hits.get(key) || []).filter((at) => now - at < this.windowMs);
        this.hits.set(key, hits);
        if (hits.length < this.limit) return 0;
        return Math.max(0, this.windowMs - (now - hits[0]) + 1);
    }

    /**
     * Reserve a slot if one is free.
     *
     * @param {string} [key]
     * @param {number} [now]
     * @returns {boolean}
     */
    reserve(key = "default", now = Date.now()) {
        if (this.waitMs(key, now) > 0) return false;
        this.hits.get(key).push(now);
        return true;
    }

    /** @param {string} [key] */
    clear(key) {
        if (key) this.hits.delete(key);
        else this.hits.clear();
    }
}

/** Counts in-flight upstream calls, including the full lifetime of a stream. */
export class Semaphore {
    /** @param {number} max */
    constructor(max) {
        if (max < 1) throw new Error("Semaphore max must be >= 1.");
        this.max = max;
        this.active = 0;
        /** @type {Array<{ resolve: (release: () => void) => void, reject: (reason: Error) => void }>} */
        this.waiters = [];
    }

    /**
     * Acquire a slot. The returned function must always be called in `finally`.
     *
     * @param {AbortSignal} [signal]
     * @returns {Promise<() => void>}
     */
    acquire(signal) {
        if (signal?.aborted) return Promise.reject(signal.reason || new Error("Aborted"));
        if (this.active < this.max) {
            this.active += 1;
            return Promise.resolve(this.#releaseOnce());
        }
        return new Promise((resolve, reject) => {
            /** @type {{ resolve: (release: () => void) => void, reject: (reason: Error) => void } | null} */
            let waiter = null;
            const onAbort = () => {
                if (waiter) this.waiters.splice(this.waiters.indexOf(waiter), 1);
                reject(signal?.reason || new Error("Aborted"));
            };
            waiter = {
                resolve: (release) => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve(release);
                },
                reject: (reason) => {
                    signal?.removeEventListener("abort", onAbort);
                    reject(reason);
                },
            };
            this.waiters.push(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    /** @returns {() => void} */
    #releaseOnce() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = this.waiters.shift();
            if (next) next.resolve(this.#releaseOnce());
            else this.active -= 1;
        };
    }
}

/**
 * Abortable sleep: a 429 wait must never keep a disconnected browser alive.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("Aborted"));
    return new Promise((resolve, reject) => {
        if (ms <= 0) return resolve();
        const timer = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timer);
            done();
        };
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) reject(signal.reason || new Error("Aborted"));
            else resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Full-jitter exponential backoff.
 *
 * @param {number} attempt - 1-based attempt number that just failed.
 * @param {number} baseMs
 * @param {number} maxMs
 * @returns {number}
 */
export function backoff(attempt, baseMs, maxMs) {
    const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}
