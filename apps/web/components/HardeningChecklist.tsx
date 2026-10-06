"use client";

import { useState } from "react";
import type { AccountHardeningItemId, AccountHardeningScore, AccountHardeningState } from "@neo/core";
import type { HardeningItemView } from "@/lib/hardening-types";

type AnswerValue = boolean | "not_applicable" | "clear";

const STATE_LABELS: Record<AccountHardeningState, string> = {
  complete: "Complete",
  needs_action: "Needs action",
  unanswered: "Not answered",
  stale: "Answer is over 180 days old: confirm again",
  unknown: "Data unavailable right now",
  not_applicable: "Not applicable",
};

function dateOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function told(item: HardeningItemView, state: AccountHardeningState, answeredAt: string | null): string | null {
  if (item.source !== "self_attested" || !answeredAt) return null;
  const when = dateOf(answeredAt);
  if (state === "complete") return `You told Neo: Yes (${when})`;
  if (state === "needs_action") return `You told Neo: No (${when})`;
  if (state === "not_applicable") return `You told Neo: Not applicable (${when})`;
  return `You told Neo on ${when}`;
}

/** The signed-in person's full checklist. Answers are self-attested, never verified by Neo. */
export function HardeningChecklist({ initialScore, items }: { initialScore: AccountHardeningScore; items: HardeningItemView[] }) {
  const [score, setScore] = useState(initialScore);
  const [busy, setBusy] = useState<AccountHardeningItemId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(itemId: AccountHardeningItemId, value: AnswerValue) {
    setBusy(itemId); setError(null);
    try {
      const res = await fetch("/api/hardening-score/answers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, checklistVersion: score.checklistVersion, value }),
      });
      if (res.status === 409) { setError("The checklist changed. Reload the page and answer again."); return; }
      if (!res.ok) throw new Error("save failed");
      setScore(await res.json() as AccountHardeningScore);
    } catch {
      setError("Could not save your answer. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const button = "min-h-11 rounded-lg border border-border bg-surface px-3 text-sm hover:bg-surface-2 disabled:opacity-50";
  return <div className="mx-auto w-full max-w-2xl">
    <h1 className="text-3xl font-semibold tracking-tight">Account hardening</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted">
      Answers marked &ldquo;You told Neo&rdquo; are what you say, not something Neo has verified with your providers. Only you can see
      this checklist; a household owner sees just your percentage. Answers older than 180 days need confirming again.
    </p>
    <p className="mt-4 text-lg font-medium" aria-live="polite">
      {score.scorePercent === null ? "Not enough answers yet (answer at least 3 questions)" : `Your score: ${score.scorePercent}%`}
      {score.partial ? <span className="ml-2 text-sm font-normal text-muted">Partial: some Neo data is unavailable</span> : null}
    </p>
    <p role="alert" className="mt-2 min-h-5 text-sm text-red-700 dark:text-red-300">{error ?? ""}</p>
    <ul className="mt-2 space-y-4">
      {items.map(item => {
        const row = score.items.find(i => i.id === item.id);
        if (!row) return null;
        const disabled = busy !== null;
        const selfAttested = item.source === "self_attested";
        const naOffered = item.notApplicableWhen !== undefined;
        return <li key={item.id} aria-labelledby={`hardening-${item.id}`} className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 id={`hardening-${item.id}`} className="text-base font-medium">{item.title}</h2>
            <span className="shrink-0 text-xs text-muted">{row.weight} points</span>
          </div>
          <p className="mt-1 text-sm text-muted">{item.rule}</p>
          <p className="mt-2 text-sm font-medium" data-state={row.state}>Status: {STATE_LABELS[row.state]}</p>
          {told(item, row.state, row.answeredAt) ? <p className="text-sm text-muted">{told(item, row.state, row.answeredAt)}</p> : null}
          {!selfAttested ? <p className="text-sm text-muted">Neo checks its own records for this item.</p> : null}
          {row.state === "needs_action" || row.state === "unanswered" || row.state === "stale" ? <p className="mt-1 text-sm">Next step: {item.action}</p> : null}
          {item.helpLinks.length > 0 ? <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={`Official help for ${item.title}`}>
            {item.helpLinks.map(l => <li key={l.href}>
              <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{l.provider}</a>
            </li>)}
          </ul> : null}
          {selfAttested || naOffered ? <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Your answer for ${item.title}`}>
            {selfAttested ? <>
              <button type="button" className={button} disabled={disabled} onClick={() => answer(item.id, true)}>Yes</button>
              <button type="button" className={button} disabled={disabled} onClick={() => answer(item.id, false)}>No</button>
            </> : null}
            {naOffered ? <button type="button" className={button} disabled={disabled} onClick={() => answer(item.id, "not_applicable")} title={item.notApplicableWhen}>Not applicable</button> : null}
            {row.answeredAt ? <button type="button" className={button} disabled={disabled} onClick={() => answer(item.id, "clear")}>Clear answer</button> : null}
          </div> : null}
          {naOffered ? <p className="mt-1 text-xs text-muted">Not applicable: {item.notApplicableWhen}</p> : null}
        </li>;
      })}
    </ul>
  </div>;
}
