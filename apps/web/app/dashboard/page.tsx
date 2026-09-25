import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { forwardingUsed, household } from "@/lib/server/verdict-data";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/** Server shell: session, household and forwarding state; widgets fetch the dashboard APIs. */
export default async function DashboardPage() {
  const session = await requireSession();
  const [home, used] = await Promise.all([household(session), forwardingUsed(session)]);
  return (
    <>
      {env().DEV_AUTH_BYPASS && <DevBypassBanner />}
      <AppShell active="dashboard">
        <Dashboard household={home} forwardingUsed={used} />
      </AppShell>
    </>
  );
}
