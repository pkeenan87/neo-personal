"use client";

import { useState, type FormEvent } from "react";
import type { SpendCapResponse } from "@/lib/server/spend-cap-settings";

const field = "min-h-11 w-32 rounded-xl border border-border bg-surface px-3 text-sm";

function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * Owners only (the page checks): the household's monthly AI spend cap (_specs/v2-m3-cutover.md section 6). Off by
 * default. Shows this month's estimated spend and how much of the cap it is; owners are alerted at 80%, and chat
 * pauses at 100% (security checks of forwarded email and device alerts keep running).
 */
export function SpendCapSection({ initial }: { initial: SpendCapResponse }) {
  const [state, setState] = useState(initial);
  const [value, setValue] = useState(initial.capCents === null ? "" : String(initial.capCents / 100));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save(capCents: number | null) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/household/spend-cap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capCents }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<SpendCapResponse> & { error?: string };
      if (!res.ok) throw new Error(data.error || "That didn't save. Try again.");
      const next = data as SpendCapResponse;
      setState(next);
      setValue(next.capCents === null ? "" : String(next.capCents / 100));
      setMessage({ kind: "ok", text: next.capCents === null ? "Spend limit is off." : "Spend limit saved." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "That didn't save. Try again." });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = Number(value);
    if (!value.trim() || !Number.isFinite(n)) return void setMessage({ kind: "error", text: "Enter a dollar amount from 1 to 10,000." });
    void save(Math.round(n * 100));
  }

  return (
    <section aria-labelledby="spend-cap-heading" className="mx-auto mt-8 w-full max-w-2xl rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 id="spend-cap-heading" className="mb-1 text-sm font-semibold">
        Monthly AI spend cap
      </h2>
      <p className="mb-3 text-xs text-muted">
        Off by default. When on, Neo emails owners at 80% of the limit and pauses chat at 100% until next month or until you raise it.
        Checks of forwarded email and device alerts keep working either way. Spend is an estimate from model usage.
      </p>
      <p className="mb-3 text-sm" aria-live="polite">
        This month so far: <strong>{dollars(state.spentCents)}</strong>
        {state.capCents !== null && state.percent !== null ? (
          <>
            {" "}
            of {dollars(state.capCents)} ({state.percent}% used)
          </>
        ) : (
          " (no limit set)"
        )}
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-muted">Limit in dollars per month</span>
          <input
            type="number"
            inputMode="decimal"
            min={1}
            max={10000}
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 25"
            className={field}
          />
        </label>
        <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-white disabled:opacity-50">
          Save limit
        </button>
        {state.capCents !== null ? (
          <button type="button" disabled={busy} onClick={() => void save(null)} className="min-h-11 rounded-xl border border-border px-4 text-sm disabled:opacity-50">
            Turn off
          </button>
        ) : null}
      </form>
      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={`mt-3 text-sm ${message.kind === "error" ? "text-red-700 dark:text-red-300" : "text-muted"}`}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
