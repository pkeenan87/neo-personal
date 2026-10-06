import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { BreachMonitoringSettings } from "@/components/BreachMonitoringSettings";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { getBreachStatusForUser } from "@/lib/server/breach-monitoring/status-service";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Breach monitoring" };
export const dynamic = "force-dynamic";

export default async function BreachMonitoringSettingsPage() {
  const session = await requireSession("/settings/breaches");
  let initial = null;
  try {
    initial = await getBreachStatusForUser({ tenantId: session.tenantId, userId: session.userId });
  } catch {
    initial = null;
  }
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <BreachMonitoringSettings initial={initial} />
      </AppShell>
    </>
  );
}
