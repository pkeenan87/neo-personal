import { REMOTE_ACCESS_TOOLS } from "@neo/tools";
import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { HouseholdSettingsView } from "@/components/HouseholdSettings";
import { MemoryPanel } from "@/components/household/MemoryPanel";
import { ProtectionMembers } from "@/components/household/ProtectionMembers";
import { RetentionSection } from "@/components/household/RetentionSection";
import { SpendCapSection } from "@/components/household/SpendCapSection";
import { env } from "@/lib/env";
import { getThreshold } from "@/lib/server/alerts";
import { householdDevices } from "@/lib/server/device-enrollment";
import { listMemoryForConsole } from "@/lib/server/household-memory";
import { listInvites } from "@/lib/server/household";
import { listMemberProfiles } from "@/lib/server/member-console";
import { getRetention } from "@/lib/server/retention-settings";
import { getSpendCap } from "@/lib/server/spend-cap-settings";
import { household } from "@/lib/server/verdict-data";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Household" };
export const dynamic = "force-dynamic";

export default async function HouseholdSettingsPage() {
  const session = await requireSession("/settings/household");
  const [summary, invites, devices, threshold, protection, memory, spendCap, retention] = await Promise.all([
    household(session),
    listInvites(session),
    householdDevices(session),
    session.role === "owner" ? getThreshold(session).catch(() => "high" as const) : Promise.resolve("high" as const),
    // The owner check re-reads the database; a member (or a storage error) simply gets no Protection section.
    session.role === "owner" ? listMemberProfiles(session).catch(() => null) : Promise.resolve(null),
    // Same for "What Neo remembers": owners only, and the page still renders when it cannot be loaded.
    session.role === "owner" ? listMemoryForConsole(session).catch(() => null) : Promise.resolve(null),
    // Same owner re-check; a member (or a storage error) gets no spend cap section.
    session.role === "owner" ? getSpendCap(session).catch(() => null) : Promise.resolve(null),
    // Data retention: owners only (members see no section); the page renders without it on a storage error.
    session.role === "owner" ? getRetention(session).catch(() => null) : Promise.resolve(null),
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
        {memory?.ok ? (
          <MemoryPanel initial={memory.value.memories} max={memory.value.max} people={protection?.ok ? protection.value.members.map((m) => ({ id: m.id, name: m.displayName })) : []} />
        ) : null}
        {spendCap?.ok ? <SpendCapSection initial={spendCap.value} /> : null}
        {retention?.ok ? <RetentionSection initial={retention.value} /> : null}
      </AppShell>
    </>
  );
}
