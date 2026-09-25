import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { VerdictDetail } from "@/components/dashboard/VerdictDetail";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { verdictDetail } from "@/lib/server/verdict-data";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Check details" };
export const dynamic = "force-dynamic";

export default async function VerdictPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, requireSession()]);
  const detail = await verdictDetail(session, id);
  if (!detail) notFound();
  return (
    <>
      {env().DEV_AUTH_BYPASS && <DevBypassBanner />}
      <AppShell active="dashboard">
        <VerdictDetail detail={detail} />
      </AppShell>
    </>
  );
}
