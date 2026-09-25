"use client";

import type { VerdictLabel } from "@neo/verdict";
import type { VerdictSummaryResponse } from "@/lib/dashboard-types";
import { VERDICT_LABELS } from "@/lib/verdict-fence";

/** Status colors (reserved for verdict labels; always shown with a text legend). */
export const LABEL_FILL: Record<VerdictLabel, string> = {
  malicious: "fill-red-600 dark:fill-red-400",
  suspicious: "fill-amber-500 dark:fill-amber-400",
  insufficient_evidence: "fill-slate-400 dark:fill-slate-500",
  likely_safe: "fill-emerald-600 dark:fill-emerald-400",
};
export const LABEL_BG: Record<VerdictLabel, string> = {
  malicious: "bg-red-600 dark:bg-red-400",
  suspicious: "bg-amber-500 dark:bg-amber-400",
  insufficient_evidence: "bg-slate-400 dark:bg-slate-500",
  likely_safe: "bg-emerald-600 dark:bg-emerald-400",
};

/** Bottom-to-top stack order: the labels that need attention sit on the baseline. */
const STACK: VerdictLabel[] = ["malicious", "suspicious", "insufficient_evidence", "likely_safe"];

type Day = VerdictSummaryResponse["perDay"][number];

/** Zero-filled UTC days ending today. */
export function fillDays(perDay: readonly Day[], sinceDays: number, now = new Date()): Day[] {
  const byDay = new Map(perDay.map((d) => [d.day, d]));
  const out: Day[] = [];
  for (let i = sinceDays - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, malicious: 0, suspicious: 0, likely_safe: 0, insufficient_evidence: 0 });
  }
  return out;
}

function shortDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const H = 120;
const GAP = 2;

/** Checks per day, stacked by verdict label (plain SVG). */
export function PerDayChart({ perDay, sinceDays }: { perDay: readonly Day[]; sinceDays: number }) {
  const days = fillDays(perDay, sinceDays);
  const max = Math.max(1, ...days.map((d) => STACK.reduce((n, k) => n + d[k], 0)));
  const slot = 100 / days.length;
  const barW = Math.max(0.6, slot * 0.7);

  return (
    <figure>
      <svg
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={`Checks per day over the last ${sinceDays} days`}
      >
        <line x1="0" x2="100" y1={H - 0.5} y2={H - 0.5} className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const total = STACK.reduce((n, k) => n + d[k], 0);
          let y = H;
          const x = i * slot + (slot - barW) / 2;
          return (
            <g key={d.day} data-testid="day-bar">
              <title>{`${shortDate(d.day)}: ${total} check${total === 1 ? "" : "s"}${STACK.filter((k) => d[k]).map((k) => `, ${d[k]} ${VERDICT_LABELS[k].toLowerCase()}`).join("")}`}</title>
              {/* Full-height hit target so the tooltip works on empty and short bars. */}
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {STACK.map((k) => {
                if (!d[k]) return null;
                const h = (d[k] / max) * (H - 4);
                y -= h;
                const drawn = Math.max(1, h - GAP);
                return <rect key={k} x={x} y={y + (h - drawn)} width={barW} height={drawn} rx={0.4} className={LABEL_FILL[k]} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted" aria-hidden="true">
        <span>{shortDate(days[0]!.day)}</span>
        <span>Today</span>
      </div>
      <Legend />
      <table className="sr-only">
        <caption>Checks per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {STACK.map((k) => (
              <th key={k} scope="col">
                {VERDICT_LABELS[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days
            .filter((d) => STACK.some((k) => d[k]))
            .map((d) => (
              <tr key={d.day}>
                <th scope="row">{shortDate(d.day)}</th>
                {STACK.map((k) => (
                  <td key={k}>{d[k]}</td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </figure>
  );
}

export function Legend() {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {STACK.map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span className={`inline-block size-2.5 rounded-sm ${LABEL_BG[k]}`} aria-hidden="true" />
          {VERDICT_LABELS[k]}
        </li>
      ))}
    </ul>
  );
}

/** Ranked horizontal bars (plain SVG) with labels and counts in text. */
export function BarList({
  items,
  label,
  empty,
  format = (s) => s,
}: {
  items: { key: string; count: number }[];
  label: string;
  empty: string;
  format?: (key: string) => string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ol className="space-y-2" aria-label={label}>
      {items.map((i) => (
        <li key={i.key}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate" title={i.key}>
              {format(i.key)}
            </span>
            <span className="shrink-0 tabular-nums text-muted">{i.count}</span>
          </div>
          <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="mt-1 h-1.5 w-full" aria-hidden="true">
            <rect x="0" y="0" width="100" height="6" rx="3" className="fill-surface-2" />
            <rect x="0" y="0" width={Math.max(2, (i.count / max) * 100)} height="6" rx="3" className="fill-accent" />
          </svg>
        </li>
      ))}
    </ol>
  );
}
