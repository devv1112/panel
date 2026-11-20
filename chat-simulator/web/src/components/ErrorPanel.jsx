/** @file Technical error display: real codes, ids and response evidence only. */

import React from "react";

/**
 * @param {{ payload: Record<string, any> | null, onDismiss?: () => void, tone?: "error" | "warning" }} props
 */
export default function ErrorPanel({ payload, onDismiss, tone = "error" }) {
    if (!payload) return null;
    const isWarning = tone === "warning";
    return (
        <div
            role="alert"
            className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                isWarning
                    ? "border-amber-700/60 bg-amber-950/30 text-amber-100"
                    : "border-red-800/70 bg-red-950/30 text-red-100"
            }`}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="font-semibold">
                        {String(payload.code || (isWarning ? "WARNING" : "ERROR"))}
                        {payload.httpStatus ? ` · HTTP ${payload.httpStatus}` : ""}
                    </p>
                    <p className="mt-1 break-words text-[11px] opacity-90">{String(payload.message || "")}</p>
                    {payload.requestId && <p className="mt-1 font-mono text-[10px] opacity-70">request_id={String(payload.requestId)}</p>}
                </div>
                {onDismiss && (
                    <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
                        ✕
                    </button>
                )}
            </div>
            <details className="mt-2 text-[10px] opacity-80">
                <summary className="cursor-pointer select-none">technical detail</summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">
                    {JSON.stringify(payload, null, 2)}
                </pre>
            </details>
        </div>
    );
}
