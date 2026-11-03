"use client";

import { useState } from "react";
import { MAX_GRANT_MINUTES, type ChildRequestDecisionResponse, type ChildRequestItem, type UnblockScope } from "@/lib/child-request-types";

const primary = "min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50";
const secondary = "min-h-11 rounded-xl border border-border bg-surface px-4 text-sm font-medium disabled:opacity-50";
const field = "min-h-11 w-24 rounded-xl border border-border bg-surface px-3 text-sm";

/** The child's own words, quoted and set apart. Never rendered as markup, never read as an instruction. */
export function RequestReason({ memberName, reason }: { memberName: string; reason: string | null }) {
  if (!reason) return null;
  return (
    <figure className="mt-2">
      <blockquote className="border-l-2 border-border pl-3 text-sm text-muted">{`“${reason}”`}</blockquote>
      <figcaption className="mt-1 text-xs text-muted">{memberName} wrote this. Neo does not act on it.</figcaption>
    </figure>
  );
}

/**
 * Approve and Deny for one pending request. The choices are the owner's: minutes for more time (capped at
 * 120), once or always for a site. What happens is written out before the button is pressed. The same
 * component serves the console list and the email-link page; with a `token` the server also spends the link.
 */
export function ChildRequestActions({
  request,
  token,
  initialAction,
  onDone,
}: {
  request: ChildRequestItem;
  token?: string;
  initialAction?: "approve" | "deny";
  onDone: (result: { request: ChildRequestItem; message: string }) => void;
}) {
  const asked = typeof request.detail.minutes === "number" ? request.detail.minutes : 15;
  const [minutes, setMinutes] = useState(String(Math.min(asked, MAX_GRANT_MINUTES)));
  const [scope, setScope] = useState<UnblockScope>("once");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const minutesNumber = Number(minutes);
  const minutesOk = Number.isInteger(minutesNumber) && minutesNumber >= 1 && minutesNumber <= MAX_GRANT_MINUTES;
  const who = request.memberName;

  const effect =
    request.kind === "more_time"
      ? `Approving gives ${who} ${minutesOk ? minutesNumber : "more"} minutes today${request.deviceName ? ` on ${request.deviceName}` : ""}.`
      : request.kind === "unblock_site"
        ? scope === "once"
          ? `Approving allows ${request.summary} for ${who} for 1 hour.`
          : `Approving always allows ${request.summary} for ${who}.`
        : `Approving allows ${request.summary.replace(/^the app /, "")} for ${who}.`;

  async function decide(decision: "approve" | "deny") {
    if (busy) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/household/requests/${encodeURIComponent(request.id)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          decision,
          ...(decision === "approve" && request.kind === "more_time" ? { minutes: minutesNumber } : {}),
          ...(decision === "approve" && request.kind === "unblock_site" ? { scope } : {}),
          ...(token ? { token } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ChildRequestDecisionResponse> & { error?: string };
      if (!res.ok || !data.request || !data.message) {
        setError(data.error || "That didn't work. Try again.");
        return;
      }
      onDone({ request: data.request, message: data.message });
    } catch {
      setError("That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-3">
      {request.kind === "more_time" && (
        <label className="flex items-center gap-2 text-sm">
          <span>Minutes to give</span>
          <input type="number" inputMode="numeric" min={1} max={MAX_GRANT_MINUTES} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={field} />
          <span className="text-xs text-muted">(up to {MAX_GRANT_MINUTES})</span>
        </label>
      )}
      {request.kind === "unblock_site" && (
        <fieldset className="space-y-1 text-sm">
          <legend className="sr-only">How long to allow it</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name={`scope-${request.id}`} checked={scope === "once"} onChange={() => setScope("once")} /> Just for 1 hour
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`scope-${request.id}`} checked={scope === "always"} onChange={() => setScope("always")} /> Always
          </label>
        </fieldset>
      )}
      <p className="text-sm text-muted">{effect}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null || (request.kind === "more_time" && !minutesOk)} onClick={() => void decide("approve")} className={initialAction === "deny" ? secondary : primary}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void decide("deny")} className={initialAction === "deny" ? primary : secondary}>
          {busy === "deny" ? "Saving…" : "Deny"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
