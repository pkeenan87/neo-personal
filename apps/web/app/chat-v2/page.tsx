import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env, eveChatEnabled } from "@/lib/env";
import { callerOwnsSession } from "@/lib/server/eve-session-owner";
import { isUuid, loadIncident } from "@/lib/server/incident-data";
import { requireSession } from "@/lib/session";
import { EveChat } from "./EveChat";

export const metadata: Metadata = { title: "Ask Neo" };
export const dynamic = "force-dynamic";

/**
 * The eve incident chat (_specs/v2-m1-elder.md section 7), behind NEO_EVE_CHAT (off: 404, before any
 * sign-in redirect). `?incident=<id>` must be an alert in the caller's household (a member: about
 * them); otherwise 404. The agent re-checks all of this in its own process.
 */
export default async function ChatV2Page({ searchParams }: { searchParams: Promise<{ incident?: string | string[] }> }) {
  if (!eveChatEnabled()) notFound();
  const raw = (await searchParams).incident;
  const incident = Array.isArray(raw) ? raw[0] : raw;
  const session = await requireSession(incident ? `/chat-v2?incident=${encodeURIComponent(incident)}` : "/chat-v2");

  let resumeSessionId: string | null = null;
  if (incident !== undefined) {
    if (!isUuid(incident)) notFound();
    const found = await loadIncident({ tenantId: session.tenantId, userId: session.userId, role: session.role }, incident);
    if (!found) notFound();
    // Resume only a conversation this user started; anyone else's is never reopened (a new one starts).
    const caller = { tenantId: session.tenantId, userId: session.userId };
    resumeSessionId = found.eveSessionId && (await callerOwnsSession(caller, found.eveSessionId, { waitMs: 0 })) ? found.eveSessionId : null;
  }
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="chat">
        {/* Keyed so a different incident never reuses another conversation's hook. */}
        <EveChat key={incident ?? "none"} {...(incident ? { incidentId: incident.toLowerCase() } : {})} resumeSessionId={resumeSessionId} />
      </AppShell>
    </>
  );
}
