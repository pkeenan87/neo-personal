import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { ForwardingSettingsView } from "@/components/ForwardingSettings";
import { env } from "@/lib/env";
import { loadForwardingSettings } from "@/lib/server/inbound/forwarding-settings";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Forwarding" };
export const dynamic = "force-dynamic";

export default async function ForwardingSettingsPage() {
  const session = await requireSession();
  const settings = await loadForwardingSettings(session);
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <ForwardingSettingsView initial={settings} />
      </AppShell>
    </>
  );
}
