"use client";

import { useEveAgent } from "eve/react";
import { useEffect, useRef } from "react";

const FIRST_QUESTION = "What happened with this alert? Please explain it simply.";

/** Reports the eve session of an incident chat so reopening the alert resumes it. Best effort: the chat works without it. */
function linkSession(incidentId: string, sessionId: string): void {
  void fetch("/api/chat-v2/incident-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ incidentId, sessionId }),
  }).catch(() => {});
}

/**
 * Chat with the eve agent. Same-origin cookies authenticate the request (agent/channels/eve.ts).
 * With `incidentId` it opens by asking about that alert; the agent fetches the alert itself with
 * `get_incident` after the server has checked the id (agent/lib/incident-context.ts), so no alert
 * text travels through the page. `resumeSessionId` is the session already linked to the alert.
 */
export function EveChat({ incidentId, resumeSessionId = null }: { incidentId?: string; resumeSessionId?: string | null }) {
  const linked = useRef<string | null>(resumeSessionId);
  const started = useRef(false);
  const context = incidentId ? { clientContext: { incidentId } } : undefined;
  const agent = useEveAgent({
    ...(resumeSessionId ? { initialSession: { sessionId: resumeSessionId, streamIndex: 0 }, resume: true } : {}),
    onSessionChange(session) {
      if (incidentId && session && session.sessionId !== linked.current) {
        linked.current = session.sessionId;
        linkSession(incidentId, session.sessionId);
      }
    },
  });
  const resuming = agent.status === "resuming";
  const busy = agent.status === "busy";

  // A new incident chat opens by asking about the alert (once, even under React strict mode).
  useEffect(() => {
    if (!incidentId || resumeSessionId || started.current) return;
    started.current = true;
    void agent.send(FIRST_QUESTION, { clientContext: { incidentId } });
  }, [agent, incidentId, resumeSessionId]);

  function startOver() {
    if (!incidentId) return;
    linked.current = null;
    agent.newSession();
    void agent.send(FIRST_QUESTION, { clientContext: { incidentId } });
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="mb-1 text-lg font-semibold tracking-tight">{incidentId ? "Ask Neo about this alert" : "Ask Neo"}</h1>
      <p className="mb-4 text-sm text-muted">Neo can look at this and explain it. It cannot change anything on any device.</p>
      <div className="space-y-3" aria-live="polite">
        {agent.messages.map((m) => (
          <article key={m.id} className={`rounded-2xl border border-border p-3 ${m.role === "user" ? "bg-surface-2" : "bg-surface"}`}>
            <p className="mb-1 text-xs font-medium text-muted">{m.role === "user" ? "You" : "Neo"}</p>
            {m.parts.map((p, i) => (p.type === "text" ? <p key={p.id ?? i} className="whitespace-pre-wrap text-sm">{p.text}</p> : null))}
          </article>
        ))}
        {busy && <p className="text-sm text-muted">Neo is looking…</p>}
      </div>
      {agent.error && (
        <div role="alert" className="mt-3 rounded-xl border border-red-300/60 p-3 text-sm text-red-700 dark:text-red-300">
          <p>Something went wrong with the chat.</p>
          {incidentId && (
            <button type="button" onClick={startOver} className="mt-2 min-h-11 rounded-lg px-3 text-sm underline">
              Start a new conversation
            </button>
          )}
        </div>
      )}
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("message") as HTMLInputElement;
          const text = input.value.trim();
          if (text && !resuming) {
            void agent.send(text, context);
            input.value = "";
          }
        }}
      >
        <input name="message" disabled={resuming} aria-label="Message" className="min-h-11 flex-1 rounded-xl border border-border bg-surface px-3 text-sm" />
        <button type="submit" disabled={resuming} className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}
