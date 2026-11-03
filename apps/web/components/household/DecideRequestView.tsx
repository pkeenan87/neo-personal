"use client";

import Link from "next/link";
import { useState } from "react";
import type { ChildRequestItem } from "@/lib/child-request-types";
import { ChildRequestActions, RequestReason } from "./ChildRequestActions";

const KIND_LABEL: Record<ChildRequestItem["kind"], string> = { more_time: "More time", unblock_site: "Unblock a site", install_app: "Allow an app" };

export type DecideViewState = "ready" | "forbidden" | "decided" | "expired" | "token_invalid" | "token_expired";

const MESSAGE: Record<Exclude<DecideViewState, "ready">, string> = {
  forbidden: "Only a household owner can answer a request. Sign in with an owner's account to continue.",
  decided: "This request has already been answered, so this link no longer does anything.",
  expired: "This request has expired. A request only lasts until the end of the child's day, and your child can ask again.",
  token_invalid: "This link isn't valid for this request.",
  token_expired: "This link has expired (they last 24 hours). You can still answer from the child's page in Neo.",
};

/**
 * The page behind the Approve and Deny links in a request email (_specs/v2-m2-child.md section 8). Opening
 * the link decides nothing: it shows the request and asks for a confirm. The email's choice only picks which
 * button is highlighted.
 */
export function DecideRequestView({ state, request, token, action }: { state: DecideViewState; request: ChildRequestItem | null; token: string; action: "approve" | "deny" }) {
  const [done, setDone] = useState<{ message: string } | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Answer a request</h1>
        {request ? <p className="text-sm text-muted">{request.memberName} asked from {request.deviceName ?? "a device"}.</p> : null}
      </header>

      {done ? (
        <div role="status" className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-5 text-sm shadow-sm">
          <p className="font-medium">{done.message}</p>
          <Link href="/dashboard" className="mt-3 inline-block text-sm text-accent underline">
            Go to your dashboard
          </Link>
        </div>
      ) : state !== "ready" || !request ? (
        <div role="alert" className="rounded-2xl border border-border bg-surface p-5 text-sm shadow-sm">
          <p>{MESSAGE[state === "ready" ? "token_invalid" : state]}</p>
          <Link href="/dashboard" className="mt-3 inline-block text-sm text-accent underline">
            Go to your dashboard
          </Link>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <p className="text-sm">
            <strong>{request.memberName}</strong> · {KIND_LABEL[request.kind]}: <strong>{request.summary}</strong>
          </p>
          <RequestReason memberName={request.memberName} reason={request.reason} />
          <ChildRequestActions request={request} token={token} initialAction={action} onDone={(r) => setDone({ message: r.message })} />
          <p className="mt-3 text-xs text-muted">Nothing happens until you press a button. This link works once.</p>
        </div>
      )}
    </div>
  );
}
