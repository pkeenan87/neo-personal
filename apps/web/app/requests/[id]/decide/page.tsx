/**
 * /requests/<id>/decide?t=<token>&a=approve|deny — the page behind the Approve and Deny links in a
 * child-request email (_specs/v2-m2-child.md section 8). Signed-out visitors sign in first and come back.
 * Only a signed-in household owner sees the request; the token only identifies it. Opening the page never
 * decides anything: the confirm button posts to /api/household/requests/[id]/decision. The token is in the
 * query string, so next.config.ts sends `Referrer-Policy: no-referrer` for /requests/*.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DevBypassBanner } from "@/components/DevBypassBanner";
import { DecideRequestView } from "@/components/household/DecideRequestView";
import { env } from "@/lib/env";
import { previewDecisionLink } from "@/lib/server/child-requests";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Answer a request", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function DecideRequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string | string[]; a?: string | string[] }> }) {
  const { id } = await params;
  const query = await searchParams;
  const token = first(query.t)?.slice(0, 200) ?? "";
  const action = first(query.a) === "deny" ? "deny" : "approve";
  const returnTo = `/requests/${encodeURIComponent(id)}/decide?${new URLSearchParams({ t: token, a: action }).toString()}`;
  const session = await requireSession(returnTo);

  let state;
  try {
    state = await previewDecisionLink(session, id, token);
  } catch {
    return (
      <AppShell active="dashboard">
        <p className="mx-auto max-w-lg text-sm" role="alert">
          Neo cannot check this request right now. Please try again in a moment.
        </p>
      </AppShell>
    );
  }
  // Another household's request, or none at all: the same 404, so an id confirms nothing.
  if (state.state === "not_found") notFound();

  return (
    <>
      {env().DEV_AUTH_BYPASS ? <DevBypassBanner /> : null}
      <AppShell active="dashboard">
        <DecideRequestView state={state.state} request={"request" in state ? state.request : null} token={token} action={action} />
      </AppShell>
    </>
  );
}
