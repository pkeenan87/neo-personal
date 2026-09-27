"use client";

import { Home, UserPlus } from "lucide-react";
import { useState } from "react";
import { signOut } from "@/lib/auth-client";
import type { AcceptInviteResponse, InvitePreviewResponse } from "@/lib/household-types";

export interface InviteViewError {
  code: string;
  message: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What joining deletes, as short phrases; empty when the current household holds nothing. */
export function deletionSummary(current: NonNullable<InvitePreviewResponse["currentHousehold"]>): string[] {
  const items: string[] = [];
  if (current.conversationCount > 0) items.push(plural(current.conversationCount, "chat"));
  if (current.verdictCount > 0) items.push(plural(current.verdictCount, "saved check"));
  if (current.hasForwardingAddress) items.push("your forwarding address");
  return items;
}

export function InviteView({
  secret,
  preview,
  error,
  account,
}: {
  secret: string;
  preview: InvitePreviewResponse | null;
  error: InviteViewError | null;
  account: { email: string; name: string };
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<InviteViewError | null>(error);
  const [joined, setJoined] = useState<AcceptInviteResponse | null>(null);
  const [understood, setUnderstood] = useState(false);

  const current = preview?.currentHousehold ?? null;
  const losing = current ? deletionSummary(current) : [];
  const needsAck = losing.length > 0;
  const who = account.email ? `${account.name} (${account.email})` : account.name;

  async function accept() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(secret)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ confirmLeave: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        setFailure({ code: body.code ?? "error", message: body.error ?? "Something went wrong. Please try again." });
        return;
      }
      setJoined((await res.json()) as AcceptInviteResponse);
    } catch {
      setFailure({ code: "error", message: "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  if (joined) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
        <div role="status" className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-5 text-sm shadow-sm">
          <p className="font-medium">You joined {joined.householdName}.</p>
          <p className="mt-1 text-muted">Neo now looks out for you as part of this household.</p>
        </div>
        <a href="/dashboard" className="flex min-h-11 items-center justify-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg">
          Go to your dashboard
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <UserPlus className="size-6 text-accent" aria-hidden="true" />
          {preview ? `Join ${preview.householdName}` : "Household invite"}
        </h1>
        <p className="text-sm text-muted">
          Signed in as <strong className="text-fg">{who}</strong>.
        </p>
      </header>

      {failure ? (
        <div role="alert" className="rounded-2xl border border-border bg-surface p-5 text-sm shadow-sm">
          <p>{failure.message}</p>
          {failure.code === "email_mismatch" ? (
            <button
              type="button"
              onClick={() => void signOut({ callbackUrl: `/invite/${secret}` })}
              className="mt-3 text-sm text-accent underline"
            >
              Sign out and use a different account
            </button>
          ) : null}
          {failure.code === "owns_household_with_members" ? (
            <a href="/settings/household" className="mt-3 inline-block text-sm text-accent underline">
              Open household settings
            </a>
          ) : null}
          {failure.code === "not_found" ? <p className="mt-2 text-muted">Ask the person who invited you for a new invite.</p> : null}
        </div>
      ) : null}

      {preview && preview.alreadyMember ? (
        <div className="rounded-2xl border border-border bg-surface p-5 text-sm shadow-sm">
          <p>You are already in {preview.householdName}.</p>
          <a href="/dashboard" className="mt-3 inline-block text-sm text-accent underline">
            Go to your dashboard
          </a>
        </div>
      ) : null}

      {preview && !preview.alreadyMember && failure?.code !== "email_mismatch" && failure?.code !== "not_found" ? (
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <p className="text-sm">
            {preview.inviterName ? <strong>{preview.inviterName}</strong> : "Someone"} invited you to join <strong>{preview.householdName}</strong>{" "}
            on Neo.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>The household owner can see the checks you run. Your chats stay private.</li>
            <li>You share the household&apos;s monthly checks.</li>
            <li>You can leave at any time under Settings → Household.</li>
          </ul>

          {!preview.emailMatches ? (
            <p className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
              This invite was sent to a different email address. Sign in with that address to accept it.
            </p>
          ) : null}

          {current ? (
            <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
              <p className="flex items-center gap-2 font-medium">
                <Home className="size-4" aria-hidden="true" />
                Joining replaces {current.name}.
              </p>
              {needsAck ? (
                <>
                  <p className="mt-1">It will be deleted with everything in it: {losing.join(", ")}. This cannot be undone.</p>
                  <label className="mt-3 flex min-h-11 items-center gap-2">
                    <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="size-4" />I
                    understand
                  </label>
                </>
              ) : (
                <p className="mt-1">It has nothing in it yet, so nothing is lost.</p>
              )}
            </div>
          ) : null}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy || !preview.emailMatches || (needsAck && !understood)}
              onClick={() => void accept()}
              className="min-h-11 flex-1 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              Join {preview.householdName}
            </button>
            <a
              href="/dashboard"
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2"
            >
              Not now
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
