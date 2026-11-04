import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { HOW_TO_CHANGE } from "@/lib/consent-text";
import { getMemberShared } from "@/lib/server/member-console";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "What is shared" };
export const dynamic = "force-dynamic";

const MODE_LABEL = { standard: "Standard", child: "Child", elder: "Elder" } as const;

/** What Neo collects for one member, who sees alerts and how long it is kept. Owners and the member themselves (404 otherwise). */
export default async function MemberSharedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession(`/settings/household/members/${encodeURIComponent(id)}/shared`);
  const found = await getMemberShared(session, id).catch(() => null);
  if (!found?.ok) notFound();
  const v = found.value;
  const list = (items: string[]) => (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
  const card = "space-y-2 rounded-2xl border border-border bg-surface p-5 shadow-sm";
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <header className="space-y-1">
            {v.viewerIsOwner && (
              <p className="text-sm">
                <Link href={`/settings/household/members/${encodeURIComponent(v.member.id)}`} className="text-accent hover:underline">
                  ‹ {v.member.displayName}
                </Link>
              </p>
            )}
            <h1 className="text-2xl font-semibold tracking-tight">What Neo shares about {v.member.displayName}</h1>
            <p className="text-sm text-muted">Protection mode: {MODE_LABEL[v.member.mode]}. This is a description of what Neo collects, not the data itself.</p>
          </header>
          {v.collected.map((s) => (
            <section key={s.heading} className={card}>
              <h2 className="text-sm font-semibold">{s.heading}</h2>
              {list(s.items)}
            </section>
          ))}
          <section className={card}>
            <h2 className="text-sm font-semibold">What Neo never collects</h2>
            {list(v.neverCollected)}
          </section>
          <section className={card}>
            <h2 className="text-sm font-semibold">Who can see alerts about {v.member.displayName}</h2>
            <p className="text-sm">Owners: {v.owners.join(", ") || "none"}.</p>
            <p className="text-sm">{v.member.mode === "standard" ? "Helpers are only used in Elder and Child mode." : `Helpers: ${v.helpers.join(", ") || "none chosen"}.`}</p>
            <p className="text-sm">{v.member.displayName} can see the alerts about themselves.</p>
          </section>
          <section className={card}>
            <h2 className="text-sm font-semibold">How long it is kept</h2>
            {list(v.retention)}
          </section>
          <section className={card}>
            <h2 className="text-sm font-semibold">Changing this</h2>
            <p className="text-sm">{HOW_TO_CHANGE}</p>
            <p className="text-xs text-muted">
              Full details are in the <Link href="/privacy" className="text-accent hover:underline">privacy policy</Link>.
            </p>
          </section>
        </div>
      </AppShell>
    </>
  );
}
