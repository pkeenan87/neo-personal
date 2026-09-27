/**
 * /invite/<secret> — accept a household invite (_specs/household-invites.md).
 * Signed-out visitors sign in first and come back here. The secret is in the
 * path, so next.config.ts sends `Referrer-Policy: no-referrer` for /invite/*.
 */
import type { Metadata } from "next";
import { isInviteSecretFormat } from "@neo/db";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { InviteView, type InviteViewError } from "@/components/InviteView";
import { env } from "@/lib/env";
import type { InvitePreviewResponse } from "@/lib/household-types";
import { previewInvite } from "@/lib/server/household";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Household invite", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const NOT_FOUND: InviteViewError = {
  code: "not_found",
  message: "This invite is not valid. It may have expired, been used, or been revoked.",
};

export default async function InvitePage({ params }: { params: Promise<{ secret: string }> }) {
  const { secret: raw } = await params;
  const secret = isInviteSecretFormat(raw) ? raw : null;
  const session = await requireSession(secret ? `/invite/${secret}` : "/dashboard");

  let preview: InvitePreviewResponse | null = null;
  let error: InviteViewError | null = secret ? null : NOT_FOUND;
  if (secret) {
    try {
      const r = await previewInvite(session, secret);
      if (r.ok) preview = r.value;
      else error = { code: r.code, message: r.message };
    } catch {
      error = { code: "storage_unavailable", message: "Neo cannot check this invite right now. Please try again in a moment." };
    }
  }

  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell>
        <InviteView secret={secret ?? ""} preview={preview} error={error} account={{ email: session.email, name: session.name }} />
      </AppShell>
    </>
  );
}
