"use client";

// Lifted from the confirmation bar in Neo ChatInterface.tsx, now inline in the message.
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ConfirmationRequest } from "@/lib/chat-state";
import { safeStringify } from "./ToolTrace";

export interface ConfirmationPromptProps {
  confirmation: ConfirmationRequest;
  onDecide: (approved: boolean) => void;
  /** Focus the approve button when the prompt first appears (live stream only). */
  autoFocus?: boolean;
}

export function ConfirmationPrompt({ confirmation, onDecide, autoFocus = false }: ConfirmationPromptProps) {
  const approveRef = useRef<HTMLButtonElement>(null);
  const { status } = confirmation;
  const open = status === "pending" || status === "submitting";
  const descId = `confirm-desc-${confirmation.id}`;

  useEffect(() => {
    if (autoFocus && status === "pending") approveRef.current?.focus();
    // Only on mount: don't steal focus on later re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-muted"
        data-testid="confirmation-resolved"
      >
        {status === "approved" ? (
          <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        ) : (
          <X className="size-4" aria-hidden="true" />
        )}
        <span>
          {status === "approved" ? "You approved:" : "You declined:"} {confirmation.description}
        </span>
      </div>
    );
  }

  const inputText = safeStringify(confirmation.input);
  return (
    <div
      role="group"
      aria-label={`Neo needs your permission: ${confirmation.name}`}
      aria-describedby={descId}
      className="my-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40"
      data-testid="confirmation-prompt"
    >
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Neo needs your OK</p>
          <p id={descId} className="mt-0.5 text-sm leading-relaxed">
            {confirmation.description}
          </p>
          {inputText !== "—" && inputText !== "{}" && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted">Details</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-surface p-2 font-mono">{inputText}</pre>
            </details>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={approveRef}
              type="button"
              disabled={status === "submitting"}
              onClick={() => onDecide(true)}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:opacity-60"
            >
              {status === "submitting" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )}
              Approve
            </button>
            <button
              type="button"
              disabled={status === "submitting"}
              onClick={() => onDecide(false)}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold hover:bg-surface-2 disabled:opacity-60"
            >
              <X className="size-4" aria-hidden="true" />
              Decline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
