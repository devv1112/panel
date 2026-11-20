/** @file Chat interface. Every displayed assistant string comes from the API. */

import React, { useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import Message from "./components/Message.jsx";
import Composer from "./components/Composer.jsx";
import ErrorPanel from "./components/ErrorPanel.jsx";
import { ApiError, getAppToken, getLimits, getModels, sendFeedback, setAppToken, streamChat } from "./lib/api.js";
import {
    cacheModels,
    deleteConversation,
    listConversations,
    loadConversation,
    loadSettings,
    readModelCache,
    saveConversation,
    saveSettings,
} from "./lib/storage.js";

/** @param {unknown} error @returns {Record<string, any>} */
function describeError(error) {
    if (error instanceof ApiError) return { ...error.detail, httpStatus: error.status };
    if (error && typeof error === "object" && "toJSON" in error) return /** @type {any} */ (error).toJSON();
    const e = error instanceof Error ? error : new Error(String(error));
    return { code: e.name || "CLIENT_ERROR", message: e.message };
}

/** @returns {{ selectedModelId: string | null, activeId: string | null }} */
function initialSettings() {
    try {
        return loadSettings();
    } catch {
        return { selectedModelId: null, activeId: null };
    }
}

const BOOT = initialSettings();

export default function App() {
    const [conversations, setConversations] = useState(() => {
        try {
            return listConversations();
        } catch {
            return [];
        }
    });
    const [activeId, setActiveId] = useState(BOOT.activeId);
    const [messages, setMessages] = useState(() => {
        try {
            return BOOT.activeId ? loadConversation(BOOT.activeId)?.messages || [] : [];
        } catch {
            return [];
        }
    });
    const [models, setModels] = useState(() => {
        try {
            return readModelCache() || [];
        } catch {
            return [];
        }
    });
    const [modelId, setModelId] = useState(BOOT.selectedModelId);
    const [limits, setLimits] = useState(null);
    const [banner, setBanner] = useState(null);
    const [streaming, setStreaming] = useState(false);
    const [appToken, setAppTokenState] = useState(getAppToken);
    const abortRef = useRef(null);
    const scrollRef = useRef(null);

    /** Refresh the model list from the real public `/models` endpoint. */
    async function refreshModels(force = false) {
        const result = await getModels({ refresh: force });
        setModels(result.data);
        cacheModels(result.data);
        setModelId((current) => (result.data.some((model) => model.id === current) ? current : result.data[0].id));
    }

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const result = await getModels();
                if (cancelled) return;
                setModels(result.data);
                cacheModels(result.data);
                setModelId((current) => (result.data.some((model) => model.id === current) ? current : result.data[0].id));
            } catch (error) {
                if (!cancelled) setBanner(describeError(error));
            }
            try {
                const data = await getLimits();
                if (!cancelled) setLimits(data);
            } catch {
                // Limits are informational; a failed read must not block chat.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        try {
            saveSettings({ selectedModelId: modelId, activeId });
        } catch (error) {
            setBanner(describeError(error));
        }
    }, [modelId, activeId]);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (!activeId || messages.length === 0 || streaming) return;
            try {
                const createdAt = loadConversation(activeId)?.createdAt || Date.now();
                saveConversation({ id: activeId, createdAt, updatedAt: Date.now(), model: modelId, messages });
                setConversations(listConversations());
            } catch (error) {
                setBanner(describeError(error));
            }
        }, 350);
        return () => clearTimeout(timer);
    }, [messages, activeId, modelId, streaming]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, [messages]);

    /** @param {string} id */
    function selectConversation(id) {
        try {
            const conversation = loadConversation(id);
            setActiveId(id);
            setMessages(conversation?.messages || []);
            if (conversation?.model && models.some((model) => model.id === conversation.model)) {
                setModelId(conversation.model);
            }
        } catch (error) {
            setBanner(describeError(error));
        }
    }

    function newConversation() {
        abortRef.current?.abort();
        setActiveId(null);
        setMessages([]);
        setBanner(null);
    }

    /** @param {string} id */
    function removeConversation(id) {
        try {
            deleteConversation(id);
            setConversations(listConversations());
            if (id === activeId) {
                setActiveId(null);
                setMessages([]);
            }
        } catch (error) {
            setBanner(describeError(error));
        }
    }

    /**
     * @param {string} id
     * @param {Record<string, unknown>} patch
     */
    function patchMessage(id, patch) {
        setMessages((previous) => previous.map((message) => (message.id === id ? { ...message, ...patch } : message)));
    }

    /** @param {string} text */
    async function send(text) {
        if (streaming || !modelId) return;
        const targetId = activeId || crypto.randomUUID();
        if (!activeId) setActiveId(targetId);

        const settled = messages.filter((message) => message.status !== "streaming");
        const userMessage = {
            id: crypto.randomUUID(),
            role: /** @type {const} */ ("user"),
            content: text,
            createdAt: Date.now(),
            status: /** @type {const} */ ("ok"),
        };
        const assistantId = crypto.randomUUID();
        const assistantMessage = {
            id: assistantId,
            role: /** @type {const} */ ("assistant"),
            content: "",
            createdAt: Date.now(),
            status: /** @type {const} */ ("streaming"),
            model: modelId,
        };
        setMessages([...settled, userMessage, assistantMessage]);
        setStreaming(true);
        setBanner(null);

        const controller = new AbortController();
        abortRef.current = controller;
        try {
            await streamChat({
                model: modelId,
                messages: [...settled.map((message) => ({ role: message.role, content: message.content })), { role: "user", content: text }],
                signal: controller.signal,
                onEvent: ({ type, data }) => {
                    switch (type) {
                        case "queued":
                            patchMessage(assistantId, { waitMs: data.waitMs });
                            break;
                        case "opened":
                            patchMessage(assistantId, {
                                requestId: data.requestId,
                                answeredModel: data.answeredModel,
                                substitution: data.substitution,
                                droppedParams: data.droppedParams,
                            });
                            break;
                        case "delta":
                            setMessages((previous) =>
                                previous.map((message) =>
                                    message.id === assistantId ? { ...message, content: message.content + String(data.text || "") } : message,
                                ),
                            );
                            break;
                        case "warning":
                            patchMessage(assistantId, { warning: data.warning });
                            setBanner({ ...data.warning, tone: "warning" });
                            break;
                        case "error":
                            patchMessage(assistantId, { status: "error", error: data.error });
                            setBanner(data.error);
                            break;
                        case "done":
                            setMessages((previous) =>
                                previous.map((message) =>
                                    message.id === assistantId
                                        ? {
                                              ...message,
                                              status: "ok",
                                              usage: data.usage,
                                              finishReason: data.finishReason,
                                              requestId: data.requestId || message.requestId,
                                          }
                                        : message,
                                ),
                            );
                            break;
                        default:
                            break;
                    }
                },
            });
        } catch (error) {
            const detail = describeError(error);
            patchMessage(assistantId, {
                status: "error",
                error: controller.signal.aborted
                    ? { code: "REQUEST_ABORTED", message: "The browser aborted this request." }
                    : detail,
            });
            if (!controller.signal.aborted) setBanner(detail);
        } finally {
            setStreaming(false);
            abortRef.current = null;
            try {
                setConversations(listConversations());
            } catch {
                // The persistence effect reports storage failures separately.
            }
        }
    }

    /** @param {import("./lib/storage.js").ChatMessage} message @param {string} rating */
    async function rate(message, rating) {
        try {
            await sendFeedback({ requestId: /** @type {string} */ (message.requestId), rating });
            patchMessage(message.id, { rating });
        } catch (error) {
            setBanner(describeError(error));
        }
    }

    return (
        <div className="flex h-full">
            <Sidebar
                conversations={conversations}
                activeId={activeId}
                onSelect={selectConversation}
                onNew={newConversation}
                onDelete={removeConversation}
                limits={limits}
            />
            <main className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center gap-3 border-b border-stone-800 px-5 py-3">
                    <span className="text-sm font-semibold text-stone-200">Chat simulator</span>
                    <select
                        value={modelId || ""}
                        onChange={(event) => setModelId(event.target.value)}
                        className="rounded-md border border-stone-700 bg-[#262523] px-2 py-1 text-xs text-stone-200"
                        aria-label="Model (live list from Coarena)"
                    >
                        {!modelId && <option value="">Loading models…</option>}
                        {models.map((model) => (
                            <option key={model.id} value={model.id}>
                                {model.display_name || model.id}
                            </option>
                        ))}
                    </select>
                    <button type="button" onClick={() => void refreshModels(true)} className="text-[11px] text-stone-500 hover:text-orange-300">
                        refresh models
                    </button>
                    <input
                        type="password"
                        value={appToken}
                        onChange={(event) => {
                            setAppTokenState(event.target.value);
                            setAppToken(event.target.value);
                        }}
                        placeholder="app token (optional)"
                        aria-label="Optional app token"
                        className="ml-auto w-40 rounded-md border border-stone-700 bg-[#262523] px-2 py-1 text-xs text-stone-200"
                    />
                </header>

                {banner && (
                    <div className="px-5 pt-3">
                        <ErrorPanel
                            payload={banner}
                            onDismiss={() => setBanner(null)}
                            tone={banner.tone === "warning" ? "warning" : "error"}
                        />
                    </div>
                )}

                <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
                    {messages.length === 0 ? (
                        <div className="mx-auto max-w-3xl px-5 py-16 text-center text-sm text-stone-500">
                            No messages yet. The first reply is generated by the selected Coarena model; nothing is prefilled.
                        </div>
                    ) : (
                        messages.map((message) => <Message key={message.id} message={message} onRate={rate} />)
                    )}
                </div>
                <Composer onSend={(text) => void send(text)} onStop={() => abortRef.current?.abort()} streaming={streaming} />
            </main>
        </div>
    );
}
