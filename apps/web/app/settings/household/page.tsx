import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { HouseholdSettingsView } from "@/components/HouseholdSettings";
import { env } from "@/lib/env";
import { getThreshold } from "@/lib/server/alerts";
import { listInvites } from "@/lib/server/household";
import { household } from "@/lib/server/verdict-data";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Household" };
export const dynamic = "force-dynamic";

export default async function HouseholdSettingsPage() {
  const session = await requireSession("/settings/household");
  const [summary, invites, threshold] = await Promise.all([
    household(session),
    listInvites(session),
    session.role === "owner" ? getThreshold(session).catch(() => "high" as const) : Promise.resolve("high" as const),
  ]);
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <HouseholdSettingsView initial={{ ...summary, invites }} currentUserId={session.userId} initialThreshold={threshold} />
      </AppShell>
    </>
  );
}
