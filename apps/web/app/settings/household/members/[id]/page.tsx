import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { MemberConsole } from "@/components/household/MemberConsole";
import { MemoryPanel } from "@/components/household/MemoryPanel";
import { env, twilioEnabled } from "@/lib/env";
import { listHouseholdRequests } from "@/lib/server/child-requests";
import { listMemoryForConsole } from "@/lib/server/household-memory";
import { getMemberDetail } from "@/lib/server/member-console";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Member protection" };
export const dynamic = "force-dynamic";

/** One member's protection: name, role, mode, helpers and notify limits. Owners only (404 otherwise, so a member learns nothing). */
export default async function MemberProtectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession(`/settings/household/members/${encodeURIComponent(id)}`);
  const found = await getMemberDetail(session, id).catch(() => null);
  if (!found?.ok) notFound();
  // This child's requests; the page still renders when they cannot be loaded.
  const requests = found.value.member.mode === "child" ? await listHouseholdRequests(session, { memberId: found.value.member.id }).catch(() => undefined) : undefined;
  // What Neo remembers about this person; the page still renders when it cannot be loaded.
  const memory = await listMemoryForConsole(session, { memberId: found.value.member.id }).catch(() => null);
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        {/* Keyed so another member never reuses this form's state. */}
        <MemberConsole key={found.value.member.id} initial={found.value} smsEnabled={twilioEnabled()} {...(requests?.ok ? { requests: requests.value.requests } : {})} />
        {memory?.ok ? <MemoryPanel key={found.value.member.id} initial={memory.value.memories} max={memory.value.max} subject={{ id: found.value.member.id, name: found.value.member.displayName }} /> : null}
      </AppShell>
    </>
  );
}
