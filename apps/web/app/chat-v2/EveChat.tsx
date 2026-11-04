"use client";

import { openInteractions } from "eve/events";
import { useEveAgent, type EveMessagePart } from "eve/react";
import { useEffect, useRef } from "react";
import { MessageContent } from "@/components/MessageContent";
import { PLAYBOOK_ENTRIES, playbookPrompt } from "@/lib/playbooks";

const FIRST_QUESTION = "What happened with this alert? Please explain it simply.";

/** Reports the eve session of an incident chat so reopening the alert resumes it. Best effort: the chat works without it. */
function linkSession(incidentId: string, sessionId: string): void {
  void fetch("/api/chat-v2/incident-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ incidentId, sessionId }),
  }).catch(() => {});
}

const ACTION_TOOLS = new Set(["mark_expected", "allow_once", "confirm_signin", "remember"]);

/** What became of an acting tool call, in words. Null while it waits or for any other tool. */
function actionStatus(part: EveMessagePart): string | null {
  if (part.type !== "tool" || !ACTION_TOOLS.has(part.name)) return null;
  const outcome = part.interaction?.outcome;
  if (part.state === "completed") {
    const out = part.output as { ok?: unknown; message?: unknown } | null | undefined;
    if (out && out.ok === true && typeof out.message === "string") return out.message;
    return "Neo could not do that, so nothing was confirmed.";
  }
  if (part.state === "failed") return "Something went wrong. Nothing was confirmed.";
  if (part.state === "rejected" || part.state === "cancelled") return outcome === "declined" || part.state === "rejected" ? "Denied. Nothing was changed." : "Cancelled. Nothing was changed.";
  return null;
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
  // Approvals the agent is waiting on (the acting tools use `always()`); anything else it asks is not rendered here.
  const approvals = openInteractions(agent.view).filter((i) => i.request.kind === "approval" && i.answer === undefined);
  const busy = agent.status === "busy";
  const lastId = agent.messages.at(-1)?.id;

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
      <p className="mb-4 text-sm text-muted">Neo can look at this and explain it. It can close an alert, but only after you press Approve, and it never changes anything on a device.</p>
      {!incidentId && agent.messages.length === 0 && (
        <div className="mb-4">
          <p className="mb-2 text-sm font-medium">Something already happened?</p>
          <div className="flex flex-wrap gap-2">
            {PLAYBOOK_ENTRIES.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={resuming || busy}
                onClick={() => void agent.send(playbookPrompt(e.id), context)}
                className="min-h-11 rounded-xl border border-border px-3 text-sm disabled:opacity-50"
              >
                {e.title}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-3" aria-live="polite">
        {agent.messages.map((m) => (
          <article key={m.id} className={`rounded-2xl border border-border p-3 ${m.role === "user" ? "bg-surface-2" : "bg-surface"}`}>
            <p className="mb-1 text-xs font-medium text-muted">{m.role === "user" ? "You" : "Neo"}</p>
            {m.parts.map((p, i) => {
              if (p.type === "text") {
                if (m.role === "user") return <p key={p.id ?? i} className="whitespace-pre-wrap text-sm">{p.text}</p>;
                // Neo's replies carry verdict blocks and Markdown: shown as the old chat shows them (cards, not raw JSON).
                return (
                  <div key={p.id ?? i} className="text-sm">
                    <MessageContent text={p.text} streaming={busy && m.id === lastId} />
                  </div>
                );
              }
              const status = actionStatus(p);
              return status ? <p key={`${p.type}-${i}`} className="mt-1 rounded-lg bg-surface-2 p-2 text-sm">{status}</p> : null;
            })}
          </article>
        ))}
        {approvals.map(({ interactionId, request }) => (
          <fieldset key={interactionId} disabled={resuming} className="rounded-2xl border border-accent p-3">
            <legend className="px-1 text-sm font-semibold">Your approval is needed</legend>
            <p className="mb-3 text-sm">{request.prompt}</p>
            <div className="flex flex-wrap gap-2">
              {(request.options ?? [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }]).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => void agent.respond([{ interactionId, optionId: o.id }])}
                  className={`min-h-11 rounded-xl px-4 text-sm font-medium ${o.id === "approve" ? "bg-accent text-accent-fg" : "border border-border"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </fieldset>
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
