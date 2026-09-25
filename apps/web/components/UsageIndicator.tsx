"use client";

import { useEffect, useState } from "react";
import { getUsage } from "@/lib/agent-client";
import type { UsageResponse } from "@/lib/api-types";

function resetLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * "checks used / limit this month" from GET /api/usage. Amber from 80%, red at
 * 100% with the reset date. Re-fetched whenever `refreshKey` changes (after
 * every turn). Renders nothing until usage is known or if it can't be read.
 */
export function UsageIndicator({ refreshKey = 0 }: { refreshKey?: number }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getUsage(controller.signal)
      .then(setUsage)
      .catch(() => {
        // Usage is informational; the agent route enforces the cap.
      });
    return () => controller.abort();
  }, [refreshKey]);

  if (!usage) return null;
  const { used, limit, resetAt } = usage.monthlyChecks;
  const ratio = limit > 0 ? used / limit : 1;
  const level = ratio >= 1 ? "exhausted" : ratio >= 0.8 ? "warning" : "ok";
  const tone =
    level === "exhausted"
      ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
      : level === "warning"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        : "border-border text-muted";
  const reset = resetLabel(resetAt);
  const label = `${used} of ${limit} checks used this month${level === "exhausted" && reset ? `; resets ${reset}` : ""}`;

  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs tabular-nums ${tone}`}
      data-testid="usage-indicator"
      data-level={level}
      title={label}
      aria-label={label}
    >
      {used} / {limit}
      <span className="hidden sm:inline"> checks this month</span>
      {level === "exhausted" && reset ? <span> · resets {reset}</span> : null}
    </span>
  );
}
