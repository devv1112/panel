/** @file Conversation list: entries come from the versioned LocalStorage index. */

import React from "react";

/**
 * @param {{
 *   conversations: Array<{id: string, title: string, updatedAt: number}>,
 *   activeId: string | null,
 *   onSelect: (id: string) => void,
 *   onNew: () => void,
 *   onDelete: (id: string) => void,
 *   limits: any
 * }} props
 */
export default function Sidebar({ conversations, activeId, onSelect, onNew, onDelete, limits }) {
    return (
        <aside className="flex h-full w-64 shrink-0 flex-col border-r border-stone-800 bg-[#191817] p-3">
            <button
                type="button"
                onClick={onNew}
                className="mb-4 w-full rounded-lg border border-orange-500/60 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-200 hover:bg-orange-500/20"
            >
                + New chat
            </button>
            <p className="mb-2 px-1 text-[10px] uppercase tracking-widest text-stone-500">Conversations</p>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                {conversations.map((conversation) => (
                    <div
                        key={conversation.id}
                        className={`group flex items-center gap-1 rounded-md px-2 py-2 text-sm ${
                            conversation.id === activeId ? "bg-stone-700/70 text-stone-50" : "text-stone-400 hover:bg-stone-800/60"
                        }`}
                    >
                        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onSelect(conversation.id)}>
                            {conversation.title || "New chat"}
                        </button>
                        <button
                            type="button"
                            aria-label="Delete conversation"
                            className="opacity-0 transition group-hover:opacity-70 hover:!opacity-100"
                            onClick={() => onDelete(conversation.id)}
                        >
                            ✕
                        </button>
                    </div>
                ))}
                {conversations.length === 0 && <p className="px-2 text-xs text-stone-600">No cached conversations yet.</p>}
            </div>
            {limits && (
                <div className="mt-3 border-t border-stone-800 pt-3 text-[10px] leading-relaxed text-stone-500">
                    <p className="font-semibold text-stone-400">Live limits</p>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{JSON.stringify(limits, null, 2)}</pre>
                </div>
            )}
        </aside>
    );
}
