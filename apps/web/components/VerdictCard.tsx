"use client";

import { ExternalLink, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { VERDICT_LABELS, verdictToText } from "@/lib/verdict-fence";
import type { ActionUrgency, IndicatorSeverity, Verdict, VerdictValue } from "@/types/verdict";
import { CopyButton } from "./CopyButton";

const VERDICT_STYLE: Record<VerdictValue, { band: string; icon: typeof ShieldX; iconColor: string }> = {
  malicious: {
    band: "bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-900",
    icon: ShieldX,
    iconColor: "text-red-700 dark:text-red-300",
  },
  suspicious: {
    band: "bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-900",
    icon: ShieldAlert,
    iconColor: "text-amber-700 dark:text-amber-300",
  },
  likely_safe: {
    band: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-900",
    icon: ShieldCheck,
    iconColor: "text-emerald-700 dark:text-emerald-300",
  },
  insufficient_evidence: {
    band: "bg-slate-50 border-slate-200 dark:bg-slate-800/50 dark:border-slate-700",
    icon: ShieldQuestion,
    iconColor: "text-slate-700 dark:text-slate-300",
  },
};

const SEVERITY_STYLE: Record<IndicatorSeverity, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};

const URGENCY_LABEL: Record<ActionUrgency, string> = { now: "Do now", soon: "Soon", optional: "Optional" };
const URGENCY_STYLE: Record<ActionUrgency, string> = {
  now: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200",
  soon: "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
  optional: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};

const IOC_LABELS: Record<keyof Verdict["iocs"], string> = {
  urls: "Links",
  domains: "Domains",
  ips: "IP addresses",
  hashes: "File hashes",
  phone_numbers: "Phone numbers",
};

const SEVERITY_ORDER: IndicatorSeverity[] = ["critical", "high", "medium", "low"];

/** Defang so indicators can't be clicked or auto-linked by accident. */
export function defang(value: string): string {
  return value.replace(/^http/i, "hxxp").replace(/\./g, "[.]");
}

/** Defang evidence only when it is a bare URL/domain/IP token, not prose. */
function defangEvidence(value: string): string {
  return /^\S+\.\S+$/.test(value.trim()) ? defang(value.trim()) : value;
}

function safeHttpsLink(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function VerdictCard({ verdict, className }: { verdict: Verdict; className?: string }) {
  const style = VERDICT_STYLE[verdict.verdict];
  const Icon = style.icon;
  const pct = Math.round(verdict.confidence * 100);
  const label = VERDICT_LABELS[verdict.verdict];
  const indicators = [...verdict.indicators].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const iocGroups = (Object.keys(IOC_LABELS) as Array<keyof Verdict["iocs"]>)
    .map((k) => [k, verdict.iocs[k]] as const)
    .filter(([, v]) => v.length > 0);

  return (
    <article
      className={`my-3 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm ${className ?? ""}`}
      aria-label={`Verdict: ${label}`}
      data-verdict={verdict.verdict}
    >
      <header className={`flex items-start gap-3 border-b p-4 ${style.band}`}>
        <Icon className={`mt-0.5 size-7 shrink-0 ${style.iconColor}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className={`text-lg font-semibold ${style.iconColor}`}>{label}</h3>
            <span className="text-sm text-muted">{pct}% confidence</span>
          </div>
          <p className="mt-1 text-[15px] leading-snug font-medium">{verdict.headline}</p>
        </div>
      </header>

      <div className="space-y-4 p-4">
        {verdict.recommended_actions.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">What to do</h4>
            <ol className="space-y-2">
              {verdict.recommended_actions.map((a, i) => {
                const link = safeHttpsLink(a.deep_link);
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span
                      className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${URGENCY_STYLE[a.urgency]}`}
                    >
                      {URGENCY_LABEL[a.urgency]}
                    </span>
                    <span className="min-w-0 flex-1 leading-relaxed">
                      {a.action}
                      {link && (
                        <>
                          {" "}
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
                          >
                            Open
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                            <span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {indicators.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Why</h4>
            <ul className="space-y-2.5">
              {indicators.map((ind, i) => (
                <li key={i} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${SEVERITY_STYLE[ind.severity]}`}
                    >
                      {ind.severity}
                    </span>
                    <span className="font-medium">{ind.category}</span>
                  </div>
                  <p className="mt-1 leading-relaxed text-muted">{ind.explanation}</p>
                  {ind.evidence && (
                    <p className="mt-0.5 font-mono text-xs break-all text-muted">{defangEvidence(ind.evidence)}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {iocGroups.length > 0 && (
          <section>
            <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Indicators</h4>
            <div className="space-y-2">
              {iocGroups.map(([k, values]) => (
                <div key={k}>
                  <div className="mb-1 text-xs text-muted">{IOC_LABELS[k]}</div>
                  <ul className="flex flex-wrap gap-1.5" aria-label={IOC_LABELS[k]}>
                    {values.map((v) => (
                      <li
                        key={v}
                        className="max-w-full rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs break-all"
                        title={v}
                        data-testid="ioc-chip"
                      >
                        {defang(v)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2">
        <span className="text-xs text-muted">Neo can make mistakes. When in doubt, don&apos;t click.</span>
        <CopyButton text={verdictToText(verdict)} variant="text">
          Copy report
        </CopyButton>
      </footer>
    </article>
  );
}
