import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { RoutingSettingsView } from "@/components/RoutingSettings";
import { env } from "@/lib/env";
import { loadRoutingSettings, preferenceModels } from "@/lib/server/routing-settings";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Model routing" };
export const dynamic = "force-dynamic";

export default async function RoutingSettingsPage() {
  const session = await requireSession();
  const settings = await loadRoutingSettings(session);
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <RoutingSettingsView initial={settings} models={preferenceModels()} />
      </AppShell>
    </>
  );
}
