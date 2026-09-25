"use client";

import { ArrowLeft, Download, FileWarning, Mail, MessageSquare, RotateCw, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { Severity, Verdict } from "@neo/verdict";
import { CopyButton } from "@/components/CopyButton";
import { useToast } from "@/components/toast-context";
import { defang, VerdictCard } from "@/components/VerdictCard";
import { artifactUrl as artifactHref } from "@/lib/attachments";
import type { VerdictDetailResponse } from "@/lib/dashboard-types";

const SEVERITY_CHIP: Record<Severity, string> = {
  critical: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200",
  medium: "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

const IOC_LABELS: Record<keyof Verdict["iocs"], string> = {
  urls: "Links",
  domains: "Domains",
  ips: "IP addresses",
  hashes: "File hashes",
  phone_numbers: "Phone numbers",
};

function formatDate(iso: string): string {
  // UTC so server and client render the same text.
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Actions checklist: localStorage only ──────────────────────────

const CHECKLIST_EVENT = "neo:checklist";
export const checklistKey = (verdictId: string) => `neo.verdict-actions.${verdictId}`;

function readChecklist(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribeChecklist(cb: () => void): () => void {
  window.addEventListener("storage", cb);
  window.addEventListener(CHECKLIST_EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(CHECKLIST_EVENT, cb);
  };
}

function useChecklist(verdictId: string): [Set<number>, (i: number, done: boolean) => void] {
  const key = checklistKey(verdictId);
  const raw = useSyncExternalStore(subscribeChecklist, () => readChecklist(key), () => "[]");
  let done: Set<number>;
  try {
    const parsed: unknown = JSON.parse(raw);
    done = new Set(Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n)) : []);
  } catch {
    done = new Set();
  }
  const toggle = useCallback(
    (i: number, value: boolean) => {
      const next = new Set<number>(JSON.parse(readChecklist(key)) as number[]);
      if (value) next.add(i);
      else next.delete(i);
      try {
        window.localStorage.setItem(key, JSON.stringify([...next].sort((a, b) => a - b)));
      } catch {
        // storage unavailable (private mode): the checklist just won't persist
      }
      window.dispatchEvent(new Event(CHECKLIST_EVENT));
    },
    [key],
  );
  return [done, toggle];
}

// ─── Page body ─────────────────────────────────────────────────────

export function VerdictDetail({ detail }: { detail: VerdictDetailResponse }) {
  const v = detail.body;
  const router = useRouter();
  const { toast } = useToast();
  const [done, toggle] = useChecklist(detail.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = useCallback(async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/verdicts/${detail.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`Request failed (${res.status})`);
      toast({ intent: "success", title: "Check deleted" });
      router.push("/dashboard");
    } catch {
      setDeleting(false);
      toast({ intent: "error", title: "Couldn't delete this check" });
    }
  }, [detail.id, router, toast]);

  const indicators = [...v.indicators].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const iocGroups = (Object.keys(IOC_LABELS) as Array<keyof Verdict["iocs"]>).filter((k) => v.iocs[k].length > 0);
  const artifact = detail.artifact;
  // GET /api/artifacts/[id] downloads by default; ?inline=1 displays an image (_specs/intake.md).
  const downloadUrl = artifact ? artifactHref(artifact.id) : null;
  const inlineUrl = artifact ? artifactHref(artifact.id, true) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden="true" /> Dashboard
      </Link>

      <VerdictCard verdict={v} className="my-0!" />

      <div className="flex flex-wrap gap-2">
        <Link
          href={`/chat?verdict=${detail.id}`}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
        >
          <Sparkles className="size-4" aria-hidden="true" />
          Ask Neo about this
        </Link>
        <button
          type="button"
          onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          disabled={deleting}
          className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-4 text-sm font-medium disabled:opacity-60 ${
            confirmDelete ? "border-red-600 bg-red-600 text-white" : "border-border hover:bg-surface-2"
          }`}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {confirmDelete ? "Delete this check and its evidence?" : "Delete"}
        </button>
      </div>

      <Section title="Where this came from">
        <Origin detail={detail} />
      </Section>

      {v.recommended_actions.length > 0 && (
        <Section title="Your checklist">
          <p className="mb-2 text-xs text-muted">Tick steps off as you go. This is saved on this device only.</p>
          <ul className="space-y-2">
            {v.recommended_actions.map((a, i) => (
              <li key={i}>
                <label className="flex cursor-pointer items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={done.has(i)}
                    onChange={(e) => toggle(i, e.target.checked)}
                    className="mt-0.5 size-4 accent-[var(--accent)]"
                  />
                  <span className={done.has(i) ? "text-muted line-through" : ""}>{a.action}</span>
                </label>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {indicators.length > 0 && (
        <Section title="Warning signs">
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Severity</th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">Sign</th>
                  <th scope="col" className="py-1.5 font-medium">Evidence and why it matters</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {indicators.map((ind, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${SEVERITY_CHIP[ind.severity]}`}>
                        {ind.severity}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-medium">{ind.category}</td>
                    <td className="py-2">
                      {ind.evidence && <p className="font-mono text-xs break-all text-muted">{/^\S+\.\S+$/.test(ind.evidence.trim()) ? defang(ind.evidence.trim()) : ind.evidence}</p>}
                      <p className="mt-0.5 leading-relaxed">{ind.explanation}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {iocGroups.length > 0 && (
        <Section title="Links, domains and numbers involved">
          <div className="space-y-3">
            {iocGroups.map((k) => (
              <div key={k}>
                <h3 className="mb-1 text-xs text-muted">{IOC_LABELS[k]}</h3>
                <ul className="space-y-1" aria-label={IOC_LABELS[k]}>
                  {v.iocs[k].map((value) => (
                    <li key={value} className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface-2 px-2 py-1" data-testid="ioc-row">
                      <span className="min-w-0 flex-1 font-mono text-xs break-all">{defang(value)}</span>
                      <CopyButton text={value} label={`Copy ${value}`} />
                      {k === "urls" && /^https?:\/\//i.test(value) && (
                        <Link
                          href={`/chat?check=${encodeURIComponent(value)}`}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-surface"
                        >
                          <RotateCw className="size-3.5" aria-hidden="true" />
                          Check this URL again
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {(artifact || detail.artifactId) && (
        <Section title="Evidence">
          {!artifact ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <FileWarning className="size-4" aria-hidden="true" /> The original evidence is no longer available.
            </p>
          ) : artifact.expired ? (
            <p className="flex items-center gap-2 text-sm text-muted" suppressHydrationWarning>
              <FileWarning className="size-4" aria-hidden="true" />
              The original evidence expired{artifact.expiresAt ? ` on ${formatDate(artifact.expiresAt)}` : ""} and was deleted.
            </p>
          ) : (
            <div className="space-y-3">
              {artifact.kind === "image" && (
                // eslint-disable-next-line @next/next/no-img-element -- private, auth-gated artifact; not optimizable
                <img
                  src={inlineUrl!}
                  alt={artifact.filename ? `Evidence: ${artifact.filename}` : "Evidence screenshot"}
                  className="max-h-[32rem] rounded-xl border border-border"
                />
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <a
                  href={downloadUrl!}
                  download={artifact.filename ?? undefined}
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 font-medium hover:bg-surface-2"
                >
                  <Download className="size-4" aria-hidden="true" />
                  {artifact.kind === "eml" || artifact.kind === "inbound_eml" ? "Download raw email" : "Download"}
                </a>
                <span className="text-muted" suppressHydrationWarning>
                  {artifact.filename ?? artifact.kind} · {formatBytes(artifact.sizeBytes)}
                  {artifact.expiresAt ? ` · kept until ${formatDate(artifact.expiresAt)}` : ""}
                </span>
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function Origin({ detail }: { detail: VerdictDetailResponse }) {
  if (detail.source === "inbound") {
    const by = detail.inbound?.forwardedBy ?? detail.memberName;
    const when = detail.inbound?.receivedAt ?? detail.createdAt;
    return (
      <p className="flex items-center gap-2 text-sm" suppressHydrationWarning>
        <Mail className="size-4 text-muted" aria-hidden="true" />
        Forwarded {by ? `by ${by} ` : ""}on {formatDate(when)}
      </p>
    );
  }
  if (detail.conversation) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <MessageSquare className="size-4 text-muted" aria-hidden="true" />
        <span>
          From conversation{" "}
          <Link href={`/chat/${detail.conversation.id}`} className="font-medium text-accent underline underline-offset-2">
            {detail.conversation.title || "Untitled conversation"}
          </Link>
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted" suppressHydrationWarning>
      <MessageSquare className="size-4" aria-hidden="true" />
      {detail.conversationId ? "From a conversation" : "From a conversation that has since been deleted"}, checked on{" "}
      {formatDate(detail.createdAt)}
      {detail.memberName ? ` by ${detail.memberName}` : ""}
    </p>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm" aria-label={title}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
