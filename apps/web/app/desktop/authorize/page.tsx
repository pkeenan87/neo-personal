/**
 * /desktop/authorize?code=XXXX-XXXX — confirm a desktop sign-in started with
 * `omarchy-neo login` (or any client of POST /api/desktop/device). Signed-in
 * users only; the landing page brings them back here after Google/magic link.
 */
import type { Metadata } from "next";
import { normalizeUserCode } from "@neo/db";
import { AppShell } from "@/components/AppShell";
import { DesktopAuthorizeView } from "@/components/DesktopAuthorize";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { env } from "@/lib/env";
import { lookupDeviceAuth } from "@/lib/server/desktop-auth";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Authorize a device" };
export const dynamic = "force-dynamic";

export default async function DesktopAuthorizePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const params = await searchParams;
  const typed = typeof params.code === "string" ? params.code.slice(0, 16) : "";
  const code = typed ? normalizeUserCode(typed) : null;
  const session = await requireSession(code ? `/desktop/authorize?code=${encodeURIComponent(code)}` : "/desktop/authorize");

  let request: { clientName: string; expiresAt: string; status: "pending" | "approved" | "denied" } | null = null;
  let unavailable = false;
  if (code) {
    try {
      const r = await lookupDeviceAuth(code);
      if (r) request = { clientName: r.clientName, expiresAt: r.expiresAt.toISOString(), status: r.status };
    } catch {
      unavailable = true;
    }
  }

  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="settings">
        <DesktopAuthorizeView
          code={code}
          invalidInput={Boolean(typed) && !code}
          request={request}
          unavailable={unavailable}
          account={{ email: session.email, name: session.name }}
        />
      </AppShell>
    </>
  );
}
