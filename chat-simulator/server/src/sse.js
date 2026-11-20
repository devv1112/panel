/**
 * @file Server-Sent Events framing helpers shared by the upstream parser and
 * the browser-facing stream. The wire format sent to the browser is a small,
 * typed envelope; the upstream sees an untouched OpenAI Chat Completions body.
 */

/**
 * @param {string} event
 * @param {unknown} data
 * @returns {string}
 */
export function sseFrame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Incremental SSE parser. Blank lines are used by Coarena as keepalives after
 * a reply passes 20 seconds; they are ignored here.
 *
 * @param {(frame: { event: string, data: string }) => void} onFrame
 */
export function createSseParser(onFrame) {
    let buffer = "";

    return {
        /**
         * @param {string} chunk
         */
        feed(chunk) {
            buffer += chunk;
            let match = /\r?\n\r?\n/.exec(buffer);
            while (match) {
                const raw = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                consume(raw);
                match = /\r?\n\r?\n/.exec(buffer);
            }
        },
        end() {
            if (buffer.trim()) consume(buffer);
            buffer = "";
        },
    };

    /**
     * @param {string} raw
     */
    function consume(raw) {
        let event = "message";
        /** @type {string[]} */
        const data = [];
        for (const line of raw.split(/\r?\n/)) {
            if (!line || line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (field === "event") event = value;
            if (field === "data") data.push(value);
        }
        if (data.length === 0) return;
        onFrame({ event, data: data.join("\n") });
    }
}
