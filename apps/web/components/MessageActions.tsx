"use client";

// Lifted from Neo web/components/MessageActions.
import { CopyButton } from "./CopyButton";

/** Action row under a completed assistant message. */
export function MessageActions({ content, className }: { content: string; className?: string }) {
  return (
    <div className={`mt-1 flex items-center gap-1 ${className ?? ""}`}>
      <CopyButton text={content} label="Copy message to clipboard" />
    </div>
  );
}
