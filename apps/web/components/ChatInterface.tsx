"use client";

// Lifted from Neo web/components/ChatInterface/ChatInterface.tsx and adapted
// to the AgentEvent NDJSON contract (docs/contracts.md). Stream state lives
// in the pure reducer in lib/chat-state.ts.
import { Menu } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ApiRequestError,
  confirmAction,
  deleteConversation,
  listConversations,
  streamAgent,
  uploadArtifacts,
} from "@/lib/agent-client";
import type { ConversationSummary } from "@/lib/api-types";
import { signOut } from "@/lib/auth-client";
import { chatReducer, initialChatState, pendingConfirmation, type ChatMessage } from "@/lib/chat-state";
import { releaseAttachments, toAttachmentRef, type PendingAttachment } from "@/lib/pending-attachments";
import { ChatMessageView } from "./ChatMessageView";
import { Composer, INTAKE_HINTS } from "./Composer";
import { ConversationSidebar } from "./ConversationSidebar";
import { EmptyState, type Suggestion } from "./EmptyState";
import { playbookPrompt, type PlaybookId } from "@/lib/playbooks";
import { NeoMark } from "./NeoMark";
import { useToast } from "./toast-context";
import { UsageIndicator } from "./UsageIndicator";

export interface ChatInterfaceProps {
  user: { name: string; email: string };
  initialConversations: ConversationSummary[];
  /** null → a new, unsaved conversation (/chat). */
  conversationId: string | null;
  initialMessages?: ChatMessage[];
  // --- dashboard + incident playbooks ---
  /** Sent once on mount (from /chat?playbook= or /chat?verdict=). */
  autoStart?: { message: string; playbook?: PlaybookId; verdictId?: string };
  /** Placed in the composer (not sent), e.g. from /chat?check=<url>. */
  prefill?: string;
  // --- end dashboard + incident playbooks ---
}

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === "AbortError" : (err as { name?: string })?.name === "AbortError";
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return "Connection problem. Check your internet connection and try again.";
}

const NEAR_BOTTOM_PX = 120;

export function ChatInterface({
  user,
  initialConversations,
  conversationId,
  initialMessages = [],
  autoStart,
  prefill,
}: ChatInterfaceProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, dispatch] = useReducer(chatReducer, initialMessages, initialChatState);
  const [input, setInput] = useState(prefill ?? "");
  const [activeId, setActiveId] = useState<string | null>(conversationId);
  const [conversations, setConversations] = useState(initialConversations);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // Phase 1 intake: files for the next message, and the usage indicator refresh tick.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [usageTick, setUsageTick] = useState(0);
  // Messages that arrived during this session (vs. loaded history): used to
  // auto-focus a fresh confirmation prompt but not one restored on reload.
  const [liveFrom] = useState(initialMessages.length);

  const activeIdRef = useRef<string | null>(conversationId);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const pending = pendingConfirmation(state);

  // Abort any in-flight stream when leaving the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Follow the stream if the user is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch (err) {
      console.error("[chat] refresh conversations failed", err);
    }
  }, []);

  const announce = useCallback((text: string) => {
    setAnnouncement(text);
    setTimeout(() => setAnnouncement(""), 1500);
  }, []);

  const adoptConversationId = useCallback((id: string) => {
    if (activeIdRef.current === id) return;
    activeIdRef.current = id;
    setActiveId(id);
    // Update the URL without a navigation so the live stream keeps rendering.
    window.history.replaceState(null, "", `/chat/${id}`);
  }, []);

  const runStream = useCallback(
    async (start: (signal: AbortSignal) => Promise<unknown>) => {
      const controller = new AbortController();
      abortRef.current = controller;
      stickToBottom.current = true;
      try {
        await start(controller.signal);
        dispatch({ type: "finish" });
      } catch (err) {
        if (isAbortError(err)) {
          dispatch({ type: "interrupt" });
        } else {
          console.error("[chat] stream failed", err);
          dispatch({ type: "fail", message: errorMessage(err) });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        void refreshConversations();
        setUsageTick((n) => n + 1);
      }
    },
    [refreshConversations],
  );

  const send = useCallback(
    async (textOverride?: string, extra: { playbook?: PlaybookId; verdictId?: string } = {}) => {
      const text = (textOverride ?? input).trim();
      const files = textOverride === undefined ? attachments : [];
      if ((!text && files.length === 0) || state.streaming || pending || uploading) return;

      // Upload on send (not on attach). Files already uploaded by a failed
      // earlier attempt are reused, so a resend doesn't upload them again.
      let sent = files;
      const toUpload = files.filter((a) => !a.uploaded);
      if (toUpload.length > 0) {
        setUploading(true);
        try {
          const stored = await uploadArtifacts(toUpload.map((a) => a.file));
          const byLocal = new Map(toUpload.map((a, i) => [a.localId, stored[i]]));
          sent = files.map((a) => (byLocal.get(a.localId) ? { ...a, uploaded: byLocal.get(a.localId) } : a));
          setAttachments(sent);
        } catch (err) {
          toast({ intent: "error", title: "Couldn't upload your files", description: errorMessage(err) });
          return;
        } finally {
          setUploading(false);
        }
      }
      const uploaded = sent.flatMap((a) => (a.uploaded ? [a.uploaded] : []));

      setInput("");
      dispatch({ type: "send", userId: newId(), assistantId: newId(), text, attachments: uploaded.map(toAttachmentRef) });
      announce("Neo is responding");
      await runStream((signal) =>
        streamAgent({
          conversationId: activeIdRef.current,
          message: text,
          ...(uploaded.length ? { attachments: uploaded.map((u) => u.id) } : {}),
          ...extra,
          signal,
          onConversationId: adoptConversationId,
          // Keep the chips until the server accepts the turn, so a failed request can be resent.
          onAccepted: () => {
            if (sent.length === 0) return;
            setAttachments((prev) => {
              const done = prev.filter((a) => sent.some((s) => s.localId === a.localId));
              releaseAttachments(done);
              return prev.filter((a) => !done.includes(a));
            });
          },
          onEvent: (event) => dispatch({ type: "event", event }),
        }),
      );
    },
    [input, attachments, uploading, state.streaming, pending, announce, runStream, adoptConversationId, toast],
  );

  // --- dashboard + incident playbooks ---
  // Auto-send once. Deferred so React StrictMode's mount/unmount/mount in dev
  // does not abort the stream (the unmount cleanup aborts in-flight requests).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    const t = setTimeout(() => {
      if (autoStarted.current) return;
      autoStarted.current = true;
      if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
      void send(autoStart.message, {
        ...(autoStart.playbook ? { playbook: autoStart.playbook } : {}),
        ...(autoStart.verdictId ? { verdictId: autoStart.verdictId } : {}),
      });
    }, 0);
    return () => clearTimeout(t);
  }, [autoStart, send]);

  const startPlaybook = useCallback((id: PlaybookId) => void send(playbookPrompt(id), { playbook: id }), [send]);
  // --- end dashboard + incident playbooks ---

  const stop = useCallback(() => {
    abortRef.current?.abort();
    announce("Response stopped");
  }, [announce]);

  const decide = useCallback(
    async (id: string, approved: boolean) => {
      const convId = activeIdRef.current;
      if (!convId || state.streaming) return;
      dispatch({ type: "confirmation_status", id, status: "submitting" });
      let resumed = false;
      await runStream(async (signal) => {
        try {
          await confirmAction({
            conversationId: convId,
            id,
            approved,
            signal,
            onEvent: (event) => {
              if (!resumed) {
                resumed = true;
                dispatch({ type: "confirmation_status", id, status: approved ? "approved" : "declined" });
                dispatch({ type: "resume", assistantId: newId() });
              }
              dispatch({ type: "event", event });
            },
          });
          if (!resumed) dispatch({ type: "confirmation_status", id, status: approved ? "approved" : "declined" });
        } catch (err) {
          if (!resumed) {
            dispatch({ type: "confirmation_status", id, status: "pending" });
            if (!isAbortError(err)) toast({ intent: "error", title: "Couldn't send your answer", description: errorMessage(err) });
            return; // nothing streamed into a message; don't mark one as failed
          }
          throw err;
        }
      });
    },
    [state.streaming, runStream, toast],
  );

  const startNew = useCallback(() => {
    abortRef.current?.abort();
    dispatch({ type: "reset", messages: [] });
    setInput("");
    setAttachments((prev) => {
      releaseAttachments(prev);
      return [];
    });
    activeIdRef.current = null;
    setActiveId(null);
    setSidebarOpen(false);
    router.push("/chat");
  }, [router]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        toast({ intent: "success", title: "Conversation deleted" });
        if (activeIdRef.current === id) startNew();
      } catch (err) {
        toast({ intent: "error", title: "Couldn't delete conversation", description: errorMessage(err) });
      }
    },
    [startNew, toast],
  );

  const pickSuggestion = useCallback(
    (s: Suggestion) => {
      if (s.send) {
        void send(s.prompt);
        return;
      }
      setInput(s.prompt);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
    [send],
  );

  const title = conversations.find((c) => c.id === activeId)?.title ?? (state.messages.length ? "Conversation" : "New check");

  return (
    <div className="flex h-dvh overflow-hidden">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        user={user}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={startNew}
        onDelete={(id) => void remove(id)}
        onSignOut={() => void signOut()}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border bg-bg/90 px-3 pt-[env(safe-area-inset-top)] backdrop-blur md:px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open conversations"
            aria-controls="conversation-sidebar"
            aria-expanded={sidebarOpen}
            className="-ml-1 rounded-lg p-2 text-muted hover:bg-surface-2 md:hidden"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <NeoMark className="size-5 text-accent md:hidden" />
          <h1 className="min-w-0 flex-1 truncate py-3 text-sm font-medium">{title}</h1>
          <UsageIndicator refreshKey={usageTick} />
        </header>

        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          }}
        >
          {state.messages.length === 0 ? (
            <EmptyState onPick={pickSuggestion} onPlaybook={startPlaybook} />
          ) : (
            <div
              className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Conversation"
            >
              {state.messages.map((m, i) => (
                <ChatMessageView
                  key={m.id}
                  message={m}
                  live={i >= liveFrom}
                  onDecide={(id, approved) => void decide(id, approved)}
                />
              ))}
            </div>
          )}
        </div>

        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>

        <div className="border-t border-border bg-bg pt-3 md:border-t-0">
          <Composer
            value={input}
            onChange={setInput}
            onSend={() => void send()}
            onStop={stop}
            streaming={state.streaming}
            sendDisabled={pending !== null}
            placeholder={
              pending
                ? "Approve or decline the action above first"
                : state.messages.length
                  ? "Reply to Neo…"
                  : "Paste a link, email, or message…"
            }
            {...(!pending && state.messages.length === 0 ? { placeholderHints: INTAKE_HINTS } : {})}
            textareaRef={textareaRef}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            uploading={uploading}
          />
        </div>
      </main>
    </div>
  );
}
