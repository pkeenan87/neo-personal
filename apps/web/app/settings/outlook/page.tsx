import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { OutlookSettings } from "@/components/OutlookSettings";
import { env, outlookEnv } from "@/lib/env";
import { getOutlookView } from "@/lib/server/outlook/service";
import { getOutlookStore } from "@/lib/server/outlook/store";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Outlook" };
export const dynamic = "force-dynamic";

export default async function OutlookSettingsPage({ searchParams }: { searchParams: Promise<{ connect?: string }> }) {
  const session = await requireSession("/settings/outlook");
  const { connect } = await searchParams;
  const view = await getOutlookView(session, outlookEnv().mode, getOutlookStore());
  return <>
    {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
    <AppShell active="settings"><OutlookSettings initial={view} notice={connect ?? null} isOwner={session.role === "owner"} /></AppShell>
  </>;
}
