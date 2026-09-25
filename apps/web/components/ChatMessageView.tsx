"use client";

import { AlertTriangle, Brain } from "lucide-react";
import type { AttachmentRef } from "@/lib/attachments";
import { messageText, type ChatMessage } from "@/lib/chat-state";
import { AttachmentList } from "./AttachmentView";
import { ConfirmationPrompt } from "./ConfirmationPrompt";
import { MessageActions } from "./MessageActions";
import { MessageContent } from "./MessageContent";
import { NeoMark } from "./NeoMark";
import { ThinkingBubble } from "./ThinkingBubble";
import { ToolTrace } from "./ToolTrace";

export interface ChatMessageViewProps {
  message: ChatMessage;
  onDecide?: (confirmationId: string, approved: boolean) => void;
  /** True for messages received during this session (vs. loaded history). */
  live?: boolean;
}

export function ChatMessageView({ message, onDecide, live = false }: ChatMessageViewProps) {
  if (message.role === "user") {
    const userText = messageText(message);
    const attachments = message.parts.flatMap((p): AttachmentRef[] => (p.kind === "attachment" ? [p.attachment] : []));
    return (
      <div className="animate-neo-fade-in flex flex-col items-end gap-2" aria-label="Your message">
        {userText && (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-accent-fg sm:max-w-[75%]">
            {userText}
          </div>
        )}
        <AttachmentList attachments={attachments} />
      </div>
    );
  }

  const streaming = message.status === "streaming";
  const last = message.parts.at(-1);
  const showBubble = streaming && (!last || last.kind !== "text");
  const text = messageText(message);

  return (
    <div className="animate-neo-fade-in flex gap-3" aria-label="Neo's message" data-testid="assistant-message">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <NeoMark className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        {message.parts.map((part, i) => {
          switch (part.kind) {
            case "text":
              return <MessageContent key={i} text={part.text} streaming={streaming && i === message.parts.length - 1} />;
            case "thinking":
              return (
                <details key={i} className="my-1.5 text-sm text-muted" data-testid="thinking-part">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-0.5 hover:text-fg [&::-webkit-details-marker]:hidden">
                    <Brain className="size-3.5" aria-hidden="true" />
                    {streaming && i === message.parts.length - 1 ? "Thinking…" : "Thought process"}
                  </summary>
                  <p className="mt-1 border-l-2 border-border pl-3 leading-relaxed whitespace-pre-wrap">{part.text}</p>
                </details>
              );
            case "tool":
              return <ToolTrace key={part.trace.id + i} trace={part.trace} />;
            case "attachment":
              return null;
            case "confirmation":
              return (
                <ConfirmationPrompt
                  key={part.confirmation.id}
                  confirmation={part.confirmation}
                  autoFocus={live}
                  onDecide={(approved) => onDecide?.(part.confirmation.id, approved)}
                />
              );
          }
        })}

        {showBubble && <ThinkingBubble className="mt-1" />}

        {message.status === "interrupted" && (
          <p className="mt-1 text-xs font-medium text-muted" role="status">
            Stopped
          </p>
        )}

        {message.status === "error" && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{message.error ?? "Something went wrong."}</span>
          </div>
        )}

        {!streaming && text && <MessageActions content={text} />}
      </div>
    </div>
  );
}
