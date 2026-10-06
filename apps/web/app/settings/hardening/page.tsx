import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { HardeningChecklist } from "@/components/HardeningChecklist";
import { env } from "@/lib/env";
import { loadAccountHardeningScore } from "@/lib/server/hardening-score";
import { hardeningItemViews } from "@/lib/server/hardening-view";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Account hardening" };
export const dynamic = "force-dynamic";

/** The session user's own checklist only: there is no way to open another member's. */
export default async function HardeningSettingsPage() {
  const session = await requireSession("/settings/hardening");
  const score = await loadAccountHardeningScore(session).catch(() => null);
  return <>
    {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
    <AppShell active="settings">
      {score ? <HardeningChecklist initialScore={score} items={hardeningItemViews()} />
        : <p role="alert">Neo can&apos;t reach its storage right now. Please try again in a moment.</p>}
    </AppShell>
  </>;
}
