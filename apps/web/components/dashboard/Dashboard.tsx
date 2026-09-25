"use client";

import { CheckCircle2, ChevronRight, Loader2, Mail, MessageSquarePlus, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { VerdictLabel } from "@neo/verdict";
import { relativeTime } from "@/components/ConversationSidebar";
import { PlaybookButtons } from "@/components/PlaybookButtons";
import {
  SINCE_DAYS,
  type HouseholdResponse,
  type SinceDays,
  type UsageResponse,
  type VerdictListItem,
  type VerdictListResponse,
  type VerdictSummaryResponse,
} from "@/lib/dashboard-types";
import { VERDICT_LABELS } from "@/lib/verdict-fence";
import { BarList, LABEL_BG, PerDayChart } from "./charts";

export interface DashboardProps {
  household: HouseholdResponse;
  /** The household's forwarding address has received mail. */
  forwardingUsed: boolean;
  initialRange?: SinceDays;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: unknown };
      if (typeof b.error === "string") message = b.error;
    } catch {
      // non-JSON body
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const SUBJECT_LABEL: Record<string, string> = {
  email: "Email",
  sms: "Text message",
  url: "Link",
  page: "Web page",
  signin_alert: "Sign-in alert",
  file: "File",
  conversation: "Conversation",
};

function humanize(category: string): string {
  const s = category.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : category;
}

interface Loaded {
  key: string;
  summary: VerdictSummaryResponse;
  attention: VerdictListItem[];
  recent: VerdictListResponse;
}

export function Dashboard({ household, forwardingUsed, initialRange = 30 }: DashboardProps) {
  const [range, setRange] = useState<SinceDays>(initialRange);
  const [member, setMember] = useState<string>("");
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [more, setMore] = useState<{ loading: boolean; error?: string }>({ loading: false });

  const isOwner = household.role === "owner";
  const key = `${range}|${member}`;
  const userId = member || undefined;

  useEffect(() => {
    const controller = new AbortController();
    const since = Date.now() - range * 86_400_000;
    const list = (label?: VerdictLabel, limit = 10) =>
      getJson<VerdictListResponse>(`/api/verdicts${qs({ label, userId, limit })}`, controller.signal);
    Promise.all([
      getJson<VerdictSummaryResponse>(`/api/verdicts/summary${qs({ sinceDays: range, userId })}`, controller.signal),
      list("malicious"),
      list("suspicious"),
      list(undefined, 10),
    ])
      .then(([summary, malicious, suspicious, recent]) => {
        const attention = [...malicious.items, ...suspicious.items]
          .filter((v) => new Date(v.createdAt).getTime() >= since)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 10);
        setData({ key, summary, attention, recent });
        setError(null);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError({ key, message: err instanceof Error ? err.message : "Couldn't load your dashboard." });
      });
    return () => controller.abort();
  }, [key, range, userId]);

  useEffect(() => {
    const controller = new AbortController();
    getJson<UsageResponse>("/api/usage", controller.signal)
      .then(setUsage)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = data?.recent.nextCursor;
    if (!data || !cursor) return;
    setMore({ loading: true });
    try {
      const page = await getJson<VerdictListResponse>(`/api/verdicts${qs({ userId, limit: 10, cursor })}`);
      setData((d) =>
        d && d.key === data.key ? { ...d, recent: { items: [...d.recent.items, ...page.items], nextCursor: page.nextCursor } } : d,
      );
      setMore({ loading: false });
    } catch (err) {
      setMore({ loading: false, error: err instanceof Error ? err.message : "Couldn't load more." });
    }
  }, [data, userId]);

  const memberName = useMemo(() => {
    const names = new Map(household.members.map((m) => [m.userId, m.name ?? m.email ?? "Member"]));
    return (id: string) => names.get(id) ?? "Former member";
  }, [household.members]);

  const current = data && data.key === key ? data : null;
  const loading = !current && !(error && error.key === key);
  const isEmpty = current && current.summary.total === 0 && current.recent.items.length === 0 && !member;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{household.name}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isOwner && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Member</span>
              <select
                value={member}
                onChange={(e) => setMember(e.target.value)}
                className="min-h-10 rounded-lg border border-border bg-surface px-2 text-sm"
                aria-label="Filter by member"
              >
                <option value="">Everyone</option>
                {household.members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name ?? m.email ?? "Member"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div role="group" aria-label="Time range" className="flex rounded-lg border border-border bg-surface p-0.5">
            {SINCE_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setRange(d)}
                aria-pressed={range === d}
                className={`min-h-9 rounded-md px-3 text-sm ${range === d ? "bg-surface-2 font-semibold" : "text-muted hover:text-fg"}`}
              >
                {d} days
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && error.key === key && (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error.message}
        </p>
      )}

      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading…
        </p>
      )}

      {isEmpty ? (
        <EmptyDashboard forwardingUsed={forwardingUsed} />
      ) : (
        current && (
          <>
            <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile label="Checked" value={current.summary.total} />
              <StatTile label={VERDICT_LABELS.malicious} value={current.summary.byLabel.malicious} dot="malicious" />
              <StatTile label={VERDICT_LABELS.suspicious} value={current.summary.byLabel.suspicious} dot="suspicious" />
              <StatTile label={VERDICT_LABELS.likely_safe} value={current.summary.byLabel.likely_safe} dot="likely_safe" />
            </section>

            <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
              <div className="space-y-6">
                <Card title="Needs attention">
                  {current.attention.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-muted">
                      <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
                      Nothing dangerous or suspicious in the last {range} days.
                    </p>
                  ) : (
                    <VerdictList items={current.attention} memberName={isOwner && !member ? memberName : undefined} label="Needs attention" />
                  )}
                </Card>

                <Card title={`Checks per day (last ${range} days)`}>
                  <PerDayChart perDay={current.summary.perDay} sinceDays={range} />
                </Card>

                <Card title="Recent activity">
                  {current.recent.items.length === 0 ? (
                    <p className="text-sm text-muted">No checks yet.</p>
                  ) : (
                    <VerdictList items={current.recent.items} memberName={isOwner && !member ? memberName : undefined} label="Recent activity" />
                  )}
                  {current.recent.nextCursor && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        disabled={more.loading}
                        className="min-h-10 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
                      >
                        {more.loading ? "Loading…" : "Load more"}
                      </button>
                      {more.error && <span className="ml-2 text-sm text-red-700 dark:text-red-300">{more.error}</span>}
                    </div>
                  )}
                </Card>
              </div>

              <div className="space-y-6">
                <Card title="Quick actions">
                  <div className="space-y-2">
                    <Link
                      href="/chat"
                      className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover"
                    >
                      <MessageSquarePlus className="size-4" aria-hidden="true" />
                      Check something
                    </Link>
                    <ForwardingAction used={forwardingUsed} />
                  </div>
                  <h3 className="mt-4 mb-2 text-sm font-semibold text-muted">Something already happened?</h3>
                  <PlaybookButtons />
                </Card>

                <UsageTile usage={usage} />

                <Card title="Top warning signs">
                  <BarList
                    label="Top warning signs"
                    empty="No warning signs in this period."
                    items={current.summary.topIndicators.map((i) => ({ key: i.category, count: i.count }))}
                    format={humanize}
                  />
                </Card>

                <Card title="Most targeted brands and domains">
                  <BarList
                    label="Most targeted domains"
                    empty="No risky domains in this period."
                    items={current.summary.topDomains.map((d) => ({ key: d.domain, count: d.count }))}
                  />
                </Card>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm" aria-label={title}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function StatTile({ label, value, dot }: { label: string; value: number; dot?: VerdictLabel }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm" data-testid="stat-tile">
      <div className="flex items-center gap-1.5 text-sm text-muted">
        {dot && <span className={`inline-block size-2.5 rounded-full ${LABEL_BG[dot]}`} aria-hidden="true" />}
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function VerdictList({
  items,
  memberName,
  label,
}: {
  items: VerdictListItem[];
  memberName?: (id: string) => string;
  label: string;
}) {
  return (
    <ul className="-mx-2 divide-y divide-border" aria-label={label}>
      {items.map((v) => (
        <li key={v.id}>
          <Link href={`/verdicts/${v.id}`} className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
            <span className={`inline-block size-2.5 shrink-0 rounded-full ${LABEL_BG[v.verdict]}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{v.headline}</span>
              <span className="block text-xs text-muted" suppressHydrationWarning>
                {VERDICT_LABELS[v.verdict]} · {SUBJECT_LABEL[v.subjectType] ?? v.subjectType}
                {v.source === "inbound" ? " · forwarded" : ""}
                {memberName ? ` · ${memberName(v.userId)}` : ""} · {relativeTime(v.createdAt)}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ForwardingAction({ used }: { used: boolean }) {
  return (
    <Link
      href="/settings/forwarding"
      className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2"
    >
      {used ? (
        <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" />
      ) : (
        <Mail className="size-4 text-accent" aria-hidden="true" />
      )}
      <span className="flex-1">{used ? "Email forwarding is set up" : "Set up email forwarding"}</span>
      <ChevronRight className="size-4 text-muted" aria-hidden="true" />
    </Link>
  );
}

function UsageTile({ usage }: { usage: UsageResponse | null }) {
  if (!usage) return null;
  const pct = Math.min(100, Math.round((usage.monthlyChecks.used / Math.max(1, usage.monthlyChecks.limit)) * 100));
  return (
    <Card title="Usage this month">
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums">{usage.monthlyChecks.used}</span>
        <span className="text-muted"> of {usage.monthlyChecks.limit} checks used</span>
      </p>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label="Checks used this month"
        aria-valuemin={0}
        aria-valuemax={usage.monthlyChecks.limit}
        aria-valuenow={usage.monthlyChecks.used}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted">
        {usage.dailyTokens.used.toLocaleString("en-US")} of {usage.dailyTokens.limit.toLocaleString("en-US")} tokens used today
      </p>
    </Card>
  );
}

function EmptyDashboard({ forwardingUsed }: { forwardingUsed: boolean }) {
  const cards = [
    { href: "/chat", icon: MessageSquarePlus, title: "Check a link", body: "Paste a link or a message you're not sure about." },
    { href: "/chat", icon: Upload, title: "Upload an email or screenshot", body: "Attach a saved email (.eml) or a screenshot in the chat." },
    {
      href: "/settings/forwarding",
      icon: forwardingUsed ? CheckCircle2 : Mail,
      title: "Set up email forwarding",
      body: "Get a private address to forward suspicious emails to.",
    },
  ];
  return (
    <section aria-label="Get started" className="space-y-6">
      <div className="rounded-2xl border border-border bg-surface p-6 text-center shadow-sm">
        <h2 className="text-xl font-semibold">Nothing checked yet</h2>
        <p className="mt-1 text-muted">When your household checks something with Neo, it shows up here.</p>
      </div>
      <ul className="grid gap-3 md:grid-cols-3">
        {cards.map((c) => (
          <li key={c.title}>
            <Link href={c.href} className="flex h-full flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-sm hover:border-accent">
              <c.icon className="size-5 text-accent" aria-hidden="true" />
              <span className="font-semibold">{c.title}</span>
              <span className="text-sm text-muted">{c.body}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">Something already happened?</h2>
        <PlaybookButtons />
      </div>
    </section>
  );
}
