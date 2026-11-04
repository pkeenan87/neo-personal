"use client";

import { useState, type FormEvent } from "react";
import { RETENTION_KINDS, type RetentionKind } from "@neo/core";
import type { RetentionResponse } from "@/lib/server/retention-settings";

const field = "min-h-11 w-28 rounded-xl border border-border bg-surface px-3 text-sm";

const LABELS: Record<RetentionKind, { title: string; hint: string }> = {
  signals: { title: "Device activity", hint: "What devices report about sites and apps." },
  incidents: { title: "Alerts", hint: "Alerts you have seen go sooner (at most 90 days)." },
  childRequests: { title: "Requests from children", hint: "Decided or expired requests." },
  memory: { title: "What Neo remembers", hint: "Facts you approved. A longer time applies to new facts." },
};

/**
 * Owners only (the page checks): how long Neo keeps each kind of household data (_specs/v2-m4-hardening.md section 1).
 * The server rejects values outside the bounds; the inputs show them.
 */
export function RetentionSection({ initial }: { initial: RetentionResponse }) {
  const [bounds] = useState(initial.bounds);
  const [values, setValues] = useState<Record<RetentionKind, string>>(
    () => Object.fromEntries(RETENTION_KINDS.map((k) => [k, String(initial.settings[k])])) as Record<RetentionKind, string>,
  );
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      const body = Object.fromEntries(RETENTION_KINDS.map((k) => [k, values[k]!.trim() === "" ? null : Number(values[k])]));
      const res = await fetch("/api/household/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<RetentionResponse> & { error?: string; fields?: { path: string; message: string }[] };
      if (!res.ok) {
        setErrors(Object.fromEntries((data.fields ?? []).map((f) => [f.path, f.message])));
        throw new Error(data.error || "That didn't save. Try again.");
      }
      setMessage({ kind: "ok", text: "Retention saved. It applies at the next nightly cleanup." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "That didn't save. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="retention-heading" className="mx-auto mt-8 w-full max-w-2xl rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 id="retention-heading" className="mb-1 text-sm font-semibold">
        Data retention
      </h2>
      <p className="mb-3 text-xs text-muted">How many days Neo keeps each kind of household data before the nightly cleanup deletes it.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        {RETENTION_KINDS.map((kind) => {
          const b = bounds[kind];
          return (
            <label key={kind} className="text-sm">
              <span className="mb-1 block">
                {LABELS[kind].title} <span className="text-xs text-muted">({b.min} to {b.max} days, default {b.default})</span>
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={b.min}
                max={b.max}
                step={1}
                value={values[kind]}
                onChange={(e) => setValues({ ...values, [kind]: e.target.value })}
                aria-describedby={`retention-${kind}-hint`}
                className={field}
              />
              <span id={`retention-${kind}-hint`} className="ml-3 text-xs text-muted">
                {LABELS[kind].hint}
              </span>
              {errors[kind] ? <span role="alert" className="mt-1 block text-xs text-red-700 dark:text-red-300">{errors[kind]}</span> : null}
            </label>
          );
        })}
        <div>
          <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-white disabled:opacity-50">
            Save retention
          </button>
        </div>
      </form>
      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={`mt-3 text-sm ${message.kind === "error" ? "text-red-700 dark:text-red-300" : "text-muted"}`}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
