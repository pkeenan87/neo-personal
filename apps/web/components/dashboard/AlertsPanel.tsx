"use client";

import { BellRing, Check, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { relativeTime } from "@/components/ConversationSidebar";
import type { AlertItem, AlertListResponse, AlertSeverityName } from "@/lib/alert-types";

const SHOWN = 5;

const SEVERITY: Record<AlertSeverityName, { label: string; dot: string }> = {
  critical: { label: "Critical", dot: "bg-red-600 dark:bg-red-400" },
  high: { label: "High", dot: "bg-red-600 dark:bg-red-400" },
  medium: { label: "Medium", dot: "bg-amber-500 dark:bg-amber-400" },
  low: { label: "Low", dot: "bg-slate-400 dark:bg-slate-500" },
};

/**
 * Open owner alerts (_specs/owner-alerts.md). Owners see the household's and can mark
 * them as seen; members see alerts about themselves, read-only. Hidden when none are open.
 */
export function AlertsPanel({ initial, isOwner }: { initial: AlertListResponse; isOwner: boolean }) {
  const [items, setItems] = useState<AlertItem[]>(initial.items.filter((a) => !a.acknowledgedAt));
  const [openCount, setOpenCount] = useState(initial.openCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (openCount === 0 || items.length === 0) return null;

  async function post(url: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) throw new Error("Couldn't update the alert. Try again.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the alert. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function seen(id: string) {
    if (await post(`/api/alerts/${encodeURIComponent(id)}/acknowledge`)) {
      setItems((list) => list.filter((a) => a.id !== id));
      setOpenCount((n) => Math.max(0, n - 1));
    }
  }

  async function seenAll() {
    if (await post("/api/alerts/acknowledge-all")) {
      setItems([]);
      setOpenCount(0);
    }
  }

  const title = isOwner ? "Alerts" : "Alerts about you";
  return (
    <section aria-label={title} className="rounded-2xl border border-red-300/60 bg-surface p-5 shadow-sm dark:border-red-900/60">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <BellRing className="size-4 text-red-600 dark:text-red-400" aria-hidden="true" />
          {title}
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">{openCount}</span>
        </h2>
        {isOwner && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void seenAll()}
            className="min-h-11 rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            Mark all as seen
          </button>
        )}
      </div>
      {!isOwner && <p className="mb-2 text-xs text-muted">The household owner was told about these.</p>}
      <ul className="divide-y divide-border">
        {items.slice(0, SHOWN).map((a) => {
          const sev = SEVERITY[a.severity];
          return (
            <li key={a.id} className="flex items-start gap-3 py-3">
              <span className={`mt-1.5 inline-block size-2.5 shrink-0 rounded-full ${sev.dot}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  <span className="sr-only">{sev.label}: </span>
                  {a.title}
                </p>
                <p className="mt-0.5 line-clamp-2 text-sm text-muted">{a.body}</p>
                <p className="mt-1 text-xs text-muted">
                  {isOwner && a.subjectUserId ? `${a.subjectName ?? "Former member"} · ` : ""}
                  {relativeTime(a.createdAt)}
                  {a.verdictId ? (
                    <>
                      {" · "}
                      <Link href={`/verdicts/${a.verdictId}`} className="inline-flex items-center text-accent hover:underline">
                        See the check
                        <ChevronRight className="size-3" aria-hidden="true" />
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              {isOwner && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void seen(a.id)}
                  aria-label={`Mark "${a.title}" as seen`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                >
                  <Check className="size-4" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {openCount > SHOWN && <p className="mt-2 text-xs text-muted">and {openCount - Math.min(items.length, SHOWN)} more</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
