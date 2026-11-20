/** @file Message input with Enter-to-send and an explicit stop control. */

import React, { useState } from "react";

/**
 * @param {{ onSend: (text: string) => void, onStop: () => void, streaming: boolean }} props
 */
export default function Composer({ onSend, onStop, streaming }) {
    const [text, setText] = useState("");

    /** @param {React.KeyboardEvent<HTMLTextAreaElement>} event */
    function onKeyDown(event) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    }

    function submit() {
        const value = text.trim();
        if (!value || streaming) return;
        onSend(value);
        setText("");
    }

    return (
        <div className="border-t border-stone-800 bg-[#1f1e1d] px-5 py-4">
            <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-stone-700 bg-[#262523] p-2">
                <textarea
                    rows={2}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
                    className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-stone-100 outline-none placeholder:text-stone-600"
                />
                {streaming ? (
                    <button type="button" onClick={onStop} className="rounded-lg bg-stone-700 px-3 py-2 text-xs text-stone-100 hover:bg-stone-600">
                        Stop
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!text.trim()}
                        className="rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                    >
                        Send
                    </button>
                )}
            </div>
        </div>
    );
}
