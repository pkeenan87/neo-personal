import { REMOTE_ACCESS_TOOLS } from "@neo/tools";
import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { HouseholdSettingsView } from "@/components/HouseholdSettings";
import { ProtectionMembers } from "@/components/household/ProtectionMembers";
import { SpendCapSection } from "@/components/household/SpendCapSection";
import { env } from "@/lib/env";
import { getThreshold } from "@/lib/server/alerts";
import { householdDevices } from "@/lib/server/device-enrollment";
import { listInvites } from "@/lib/server/household";
import { listMemberProfiles } from "@/lib/server/member-console";
import { getSpendCap } from "@/lib/server/spend-cap-settings";
import { household } from "@/lib/server/verdict-data";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Household" };
export const dynamic = "force-dynamic";

export default async function HouseholdSettingsPage() {
  const session = await requireSession("/settings/household");
  const [summary, invites, devices, threshold, protection, spendCap] = await Promise.all([
    household(session),
    listInvites(session),
    householdDevices(session),
    session.role === "owner" ? getThreshold(session).catch(() => "high" as const) : Promise.resolve("high" as const),
    // The owner check re-reads the database; a member (or a storage error) simply gets no Protection section.
    session.role === "owner" ? listMemberProfiles(session).catch(() => null) : Promise.resolve(null),
    // Same owner re-check; a member (or a storage error) gets no spend cap section.
    session.role === "owner" ? getSpendCap(session).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <HouseholdSettingsView
          initial={{ ...summary, invites, ...devices }}
          currentUserId={session.userId}
          initialThreshold={threshold}
          // @neo/tools loads node:crypto, so the client gets the tool names from here.
          remoteAccessTools={REMOTE_ACCESS_TOOLS.map((t) => ({ id: t.id, name: t.name }))}
        />
        {protection?.ok ? <ProtectionMembers members={protection.value.members} /> : null}
        {spendCap?.ok ? <SpendCapSection initial={spendCap.value} /> : null}
      </AppShell>
    </>
  );
}
