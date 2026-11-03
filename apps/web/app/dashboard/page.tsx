import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env, eveChatEnabled } from "@/lib/env";
import { listHouseholdRequests } from "@/lib/server/child-requests";
import { listAlertsForSession } from "@/lib/server/alerts";
import { loadAccountHardeningScore, loadHouseholdHardeningPercents } from "@/lib/server/hardening-score";
import { hardeningItemViews } from "@/lib/server/hardening-view";
import { forwardingUsed, household } from "@/lib/server/verdict-data";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/** Server shell: session, household and forwarding state; widgets fetch the dashboard APIs. */
export default async function DashboardPage() {
  const session = await requireSession();
  const [home, used, alerts, hardeningScore, memberPercents, requests] = await Promise.all([
    household(session),
    forwardingUsed(session),
    // The dashboard still renders when alerts cannot be loaded.
    listAlertsForSession(session, { status: "open", limit: 10 }).catch(() => undefined),
    // Same for the hardening card: it is omitted rather than shown from a cache (_specs/hardening-score.md).
    loadAccountHardeningScore(session).catch(() => undefined),
    session.role === "owner" ? loadHouseholdHardeningPercents(session).catch(() => undefined) : undefined,
    // Owners see what children are asking for; the dashboard still renders when it cannot be loaded.
    session.role === "owner" ? listHouseholdRequests(session).catch(() => undefined) : undefined,
  ]);
  const hardening = hardeningScore && {
    score: hardeningScore,
    items: hardeningItemViews(),
    // Owners see other members' percentages only, never item detail.
    ...(memberPercents ? { members: memberPercents.filter(p => p.userId !== session.userId).flatMap(p => {
      const m = home.members.find(x => x.userId === p.userId);
      return m ? [{ userId: p.userId, name: m.name ?? m.email ?? "Member", scorePercent: p.scorePercent }] : [];
    }) } : {}),
  };
  return (
    <>
      {env().DEV_AUTH_BYPASS && <DevBypassBanner />}
      <AppShell active="dashboard">
        <Dashboard household={home} forwardingUsed={used} incidentChat={eveChatEnabled()} {...(requests?.ok && requests.value.requests.length > 0 ? { childRequests: requests.value.requests } : {})} {...(alerts ? { alerts } : {})} {...(hardening ? { hardening } : {})} />
      </AppShell>
    </>
  );
}
