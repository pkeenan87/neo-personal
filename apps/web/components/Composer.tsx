"use client";

// Lifted from the input area of Neo ChatInterface.tsx (skills/tier selector dropped).
// Phase 1 intake: attach button, drag-and-drop, pasted files/screenshots, and
// long pastes turned into a text attachment (_specs/intake.md).
import { ArrowUp, FileText, Loader2, Mail, Paperclip, Square, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { MAX_MESSAGE_CHARS } from "@/lib/api-types";
import { ACCEPT_ATTRIBUTE, ATTACHMENT_LIMITS, formatBytes, sanitizeFilename } from "@/lib/attachments";
import {
  preparePendingAttachments,
  releaseAttachments,
  textFileFromPaste,
  type PendingAttachment,
} from "@/lib/pending-attachments";
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
  /** When set and the box is empty, the placeholder rotates through these hints. */
  placeholderHints?: readonly string[];
  /** Optional ref to the textarea, owned by the parent (e.g. to focus it). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Files attached to the next message (owned by the parent, which uploads them on send). */
  attachments?: PendingAttachment[];
  onAttachmentsChange?: Dispatch<SetStateAction<PendingAttachment[]>>;
  /** Attachments are being uploaded. */
  uploading?: boolean;
}

const MAX_HEIGHT_PX = 240;
const HINT_INTERVAL_MS = 3500;

export const INTAKE_HINTS = ["Paste a suspicious text…", "Drop an .eml file…", "Screenshot of an email or message…"] as const;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  sendDisabled = false,
  placeholder = "Paste a link, email, or message…",
  placeholderHints,
  textareaRef,
  attachments = [],
  onAttachmentsChange,
  uploading = false,
}: ComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const innerRef = textareaRef ?? ownRef;
  const stopRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [preparing, setPreparing] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [hintIndex, setHintIndex] = useState(0);
  const canAttach = Boolean(onAttachmentsChange);
  const busy = preparing > 0 || uploading;
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !streaming && !sendDisabled && !busy;

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

  // Rotate the placeholder hints while the box is empty.
  const rotating = Boolean(placeholderHints && placeholderHints.length > 1 && value === "");
  useEffect(() => {
    if (!rotating) return;
    const t = setInterval(() => setHintIndex((i) => i + 1), HINT_INTERVAL_MS);
    return () => clearInterval(t);
  }, [rotating]);
  const shownPlaceholder =
    placeholderHints && placeholderHints.length > 0 ? placeholderHints[hintIndex % placeholderHints.length]! : placeholder;

  const addFiles = async (files: File[]) => {
    if (!onAttachmentsChange || files.length === 0) return;
    setPreparing((n) => n + 1);
    try {
      const { added, errors } = await preparePendingAttachments(files, attachments);
      if (added.length) onAttachmentsChange((prev) => [...prev, ...added]);
      for (const description of errors) toast({ intent: "warning", title: "Couldn't attach that", description });
    } finally {
      setPreparing((n) => n - 1);
    }
  };

  const removeAttachment = (localId: string) => {
    onAttachmentsChange?.((prev) => {
      releaseAttachments(prev.filter((a) => a.localId === localId));
      return prev.filter((a) => a.localId !== localId);
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    const text = data.getData("text/plain");
    const files = Array.from(data.files ?? []);
    if (!text && files.length > 0) {
      e.preventDefault();
      if (!canAttach) {
        toast({ intent: "info", title: "Attachments aren't available here", description: "Paste the text of the message or link instead." });
        return;
      }
      void addFiles(files);
      return;
    }
    if (text && value.length + text.length > MAX_MESSAGE_CHARS) {
      if (canAttach && new Blob([text]).size <= ATTACHMENT_LIMITS.textBytes) {
        // Too long for the message box: send it as a text file instead of truncating it.
        e.preventDefault();
        void addFiles([textFileFromPaste(text)]);
        toast({
          intent: "info",
          title: "Attached as a text file",
          description: `That paste is over ${MAX_MESSAGE_CHARS.toLocaleString()} characters, so Neo will read it as a file.`,
        });
        return;
      }
      toast({
        intent: "warning",
        title: "That's a lot of text",
        description: `Only the first ${MAX_MESSAGE_CHARS.toLocaleString()} characters will be sent. For a whole email, upload the .eml file.`,
      });
    }
  };

  const handleDragOver = (e: DragEvent<HTMLFormElement>) => {
    if (!canAttach || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };

  const handleDrop = (e: DragEvent<HTMLFormElement>) => {
    if (!canAttach) return;
    e.preventDefault();
    setDragging(false);
    void addFiles(Array.from(e.dataTransfer.files ?? []));
  };

  return (
    <form
      className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div
        className={`rounded-2xl border bg-surface p-2 shadow-sm focus-within:border-accent ${
          dragging ? "border-accent ring-2 ring-accent/30" : "border-border-strong"
        }`}
      >
        {(attachments.length > 0 || preparing > 0) && (
          <ul className="flex flex-wrap gap-2 px-1 pt-1 pb-2" aria-label="Attached files">
            {attachments.map((a) => (
              <li key={a.localId} className="relative" data-testid="composer-attachment">
                {a.kind === "image" && a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                  <img src={a.previewUrl} alt={sanitizeFilename(a.file.name)} className="size-16 rounded-lg border border-border object-cover" />
                ) : (
                  <span className="flex h-16 max-w-[14rem] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-xs">
                    {a.kind === "eml" ? (
                      <Mail className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{sanitizeFilename(a.file.name)}</span>
                      <span className="block text-muted">{formatBytes(a.file.size)}</span>
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.localId)}
                  disabled={uploading}
                  aria-label={`Remove ${sanitizeFilename(a.file.name)}`}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-fg text-bg shadow hover:opacity-90 disabled:opacity-40"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
            {preparing > 0 && (
              <li className="flex h-16 items-center gap-2 px-2 text-xs text-muted" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Preparing…
              </li>
            )}
          </ul>
        )}
        <div className="flex items-end gap-2">
          {canAttach && (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ACCEPT_ATTRIBUTE}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                data-testid="composer-file-input"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void addFiles(files);
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading || attachments.length >= ATTACHMENT_LIMITS.filesPerUpload}
                aria-label="Attach an email file or screenshot"
                title="Attach an .eml file or screenshot"
                className="flex size-10 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip className="size-5" aria-hidden="true" />
              </button>
            </>
          )}
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
            placeholder={shownPlaceholder}
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
              aria-label={uploading ? "Uploading attachments" : "Send message"}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg transition-opacity hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {uploading ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : <ArrowUp className="size-5" aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-center text-xs text-muted">
        Neo can make mistakes. Never share passwords or one-time codes with anyone, including Neo.
      </p>
    </form>
  );
}
