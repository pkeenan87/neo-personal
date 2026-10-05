import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { DigestSettings } from "@/components/DigestSettings";
import { env } from "@/lib/env";
import { getDigestServices } from "@/lib/server/weekly-digest/services";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Weekly digest" };
export const dynamic = "force-dynamic";
export default async function DigestSettingsPage() {
  const session = await requireSession("/settings/digest");
  const enabled = await getDigestServices().store.getPreference(session.tenantId, session.userId);
  return <>
    {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
    <AppShell active="settings">
      {enabled === undefined ? <p role="alert">A current household membership is required.</p> : <DigestSettings initialEnabled={enabled} />}
    </AppShell>
  </>;
}
