/** @file One transcript entry. Assistant text is exactly what upstream sent. */

import React from "react";
import ErrorPanel from "./ErrorPanel.jsx";

/**
 * @param {{ message: import("../lib/storage.js").ChatMessage, onRate?: (message: any, rating: string) => void }} props
 */
export default function Message({ message, onRate }) {
    const isUser = message.role === "user";
    return (
        <article className={`mx-auto w-full max-w-3xl px-5 py-4 ${isUser ? "text-stone-100" : "text-stone-200"}`}>
            <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-stone-500">
                <span>{isUser ? "you" : "assistant"}</span>
                {message.model && <span className="normal-case tracking-normal">model={String(message.model)}</span>}
                {message.status === "streaming" && <span className="text-orange-400">streaming…</span>}
            </div>
            <div className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</div>

            {message.status === "error" && message.error && (
                <div className="mt-3">
                    <ErrorPanel payload={message.error} />
                </div>
            )}
            {message.finishReason && message.finishReason !== "stop" && (
                <p className="mt-2 font-mono text-[10px] text-amber-400">finish_reason={String(message.finishReason)}</p>
            )}
            {message.usage && (
                <p className="mt-2 font-mono text-[10px] text-stone-600">{JSON.stringify(message.usage)}</p>
            )}
            {!isUser && message.requestId && (
                <div className="mt-2 flex items-center gap-3 text-[10px] text-stone-600">
                    <span className="font-mono">request_id={String(message.requestId)}</span>
                    {onRate && message.status === "ok" && (
                        <>
                            <button type="button" className="hover:text-orange-300" onClick={() => onRate(message, "up")}>
                                ↑ up
                            </button>
                            <button type="button" className="hover:text-orange-300" onClick={() => onRate(message, "down")}>
                                ↓ down
                            </button>
                            {message.rating && <span>rated={String(message.rating)}</span>}
                        </>
                    )}
                </div>
            )}
        </article>
    );
}
