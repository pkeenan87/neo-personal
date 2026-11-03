"use client";

import { useState } from "react";
import type { ChildRequestItem } from "@/lib/child-request-types";
import { ChildRequestActions, RequestReason } from "./ChildRequestActions";

const STATUS_LABEL: Record<ChildRequestItem["status"], string> = { pending: "Waiting", approved: "Approved", denied: "Said no", expired: "Expired" };
const KIND_LABEL: Record<ChildRequestItem["kind"], string> = { more_time: "More time", unblock_site: "Unblock a site", install_app: "Allow an app" };

/**
 * An owner's list of what children have asked for (_specs/v2-m2-child.md section 8): pending first, with
 * Approve and Deny. The page loads the list on the server (`initial`), so the panel makes no request until an
 * answer is sent; it narrows to one child on the member page and shows the household on the dashboard. Renders
 * nothing when there is nothing to show.
 */
export function ChildRequestsPanel({ initial, scope = "household" }: { initial: ChildRequestItem[]; scope?: string }) {
  const [requests, setRequests] = useState<ChildRequestItem[]>(initial);
  const [notice, setNotice] = useState<string | null>(null);

  if (requests.length === 0) return null;
  const pending = requests.filter((r) => r.status === "pending").length;

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm" aria-labelledby={`requests-heading-${scope}`}>
      <h2 id={`requests-heading-${scope}`} className="text-sm font-semibold">
        Requests{pending > 0 ? ` (${pending} waiting)` : ""}
      </h2>
      {notice ? (
        <p role="status" className="rounded-xl border border-border bg-bg p-3 text-sm">
          {notice}
        </p>
      ) : null}
      <ul className="space-y-3">
        {requests.map((r) => (
          <li key={r.id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm">
                <strong>{r.memberName}</strong> · {KIND_LABEL[r.kind]}: {r.summary}
                {r.deviceName ? <span className="text-muted"> · {r.deviceName}</span> : null}
              </p>
              <span className="text-xs text-muted">{STATUS_LABEL[r.status]}</span>
            </div>
            <RequestReason memberName={r.memberName} reason={r.reason} />
            {r.status === "pending" ? (
              <ChildRequestActions
                request={r}
                onDone={(result) => {
                  setRequests((cur) => cur.map((x) => (x.id === result.request.id ? result.request : x)));
                  setNotice(result.message);
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
