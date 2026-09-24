"use client";

// Lifted from the input area of Neo ChatInterface.tsx (skills/attachments/tier selector dropped).
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { MAX_MESSAGE_CHARS } from "@/lib/api-types";
import { useToast } from "./toast-context";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** A response is streaming: show Stop instead of Send. */
  streaming: boolean;
  /** Disable sending (e.g. a confirmation is awaiting a decision). Typing still allowed. */
  sendDisabled?: boolean;
  placeholder?: string;
  /** Optional ref to the textarea, owned by the parent (e.g. to focus it). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

const MAX_HEIGHT_PX = 240;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  sendDisabled = false,
  placeholder = "Paste a link, email, or message…",
  textareaRef,
}: ComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const innerRef = textareaRef ?? ownRef;
  const stopRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();
  const canSend = value.trim().length > 0 && !streaming && !sendDisabled;

  // Auto-grow the textarea with its content.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value, innerRef]);

  // Keep keyboard focus sensible across the Send ↔ Stop swap.
  // Skipped on first mount so mobile keyboards don't pop open on page load.
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    if (prevStreaming.current === streaming) return;
    prevStreaming.current = streaming;
    if (streaming) stopRef.current?.focus();
    else innerRef.current?.focus();
  }, [streaming, innerRef]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    const text = data.getData("text/plain");
    if (!text && data.files.length > 0) {
      e.preventDefault();
      toast({
        intent: "info",
        title: "Screenshots aren't supported yet",
        description: "Paste the text of the message or link instead.",
      });
      return;
    }
    if (text && value.length + text.length > MAX_MESSAGE_CHARS) {
      toast({
        intent: "warning",
        title: "That's a lot of text",
        description: `Only the first ${MAX_MESSAGE_CHARS.toLocaleString()} characters will be sent.`,
      });
    }
  };

  return (
    <form
      className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      <div className="flex items-end gap-2 rounded-2xl border border-border-strong bg-surface p-2 shadow-sm focus-within:border-accent">
        <label htmlFor="chat-input" className="sr-only">
          Message Neo
        </label>
        <textarea
          id="chat-input"
          ref={innerRef}
          value={value}
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          enterKeyHint="send"
          autoComplete="off"
          spellCheck
          className="max-h-60 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-6 placeholder:text-muted focus:outline-none sm:text-[15px]"
        />
        {streaming ? (
          <button
            ref={stopRef}
            type="button"
            onClick={onStop}
            aria-label="Stop response"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fg text-bg hover:opacity-90"
          >
            <Square className="size-4" fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            aria-label="Send message"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg transition-opacity hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUp className="size-5" aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="mt-1.5 text-center text-xs text-muted">
        Neo can make mistakes. Never share passwords or one-time codes with anyone, including Neo.
      </p>
    </form>
  );
}
