import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DesktopTokensSettingsView } from "@/components/DesktopTokensSettings";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { listTokensForSession } from "@/lib/server/desktop-tokens";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Desktop tokens" };
export const dynamic = "force-dynamic";

export default async function DesktopTokensSettingsPage() {
  const session = await requireSession();
  const tokens = await listTokensForSession(session);
  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <DesktopTokensSettingsView
          initial={tokens.map((t) => ({
            id: t.id,
            name: t.name,
            tokenPrefix: t.tokenPrefix,
            createdAt: t.createdAt.toISOString(),
            lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
          }))}
        />
      </AppShell>
    </>
  );
}
