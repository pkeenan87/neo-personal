"use client";

import { BellRing, Link2, Mail, Send, Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import type { AlertThreshold } from "@/lib/alert-types";
import type { HouseholdResponse } from "@/lib/dashboard-types";
import type { CreateInviteResponse } from "@/lib/household-types";
import { ConfirmDialog } from "./ConfirmDialog";
import { relativeTime } from "./ConversationSidebar";
import { CopyButton } from "./CopyButton";
import { DevicesSection, type RemoteAccessToolOption } from "./household/DevicesSection";
import { useToast } from "./toast-context";

type Pending =
  | { kind: "remove"; userId: string; label: string }
  | { kind: "revoke"; inviteId: string; label: string }
  | { kind: "device"; deviceId: string; label: string; memberName: string | null }
  | { kind: "leave" };

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error || fallback;
}

function expiresIn(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days <= 1) return "expires within a day";
  return `expires in ${days} days`;
}

const THRESHOLD_OPTIONS: { value: AlertThreshold; label: string; hint: string }[] = [
  { value: "high", label: "Malicious checks and new members", hint: "Recommended." },
  { value: "medium", label: "Also suspicious checks", hint: "More email, fewer surprises." },
  { value: "critical", label: "Only critical alerts", hint: "Critical alerts come with device monitoring, which is not available yet, so for now this sends nothing." },
  { value: "off", label: "Nothing", hint: "Alerts still appear on your dashboard." },
];

export function HouseholdSettingsView({
  initial,
  currentUserId,
  initialThreshold = "high",
  remoteAccessTools = [],
}: {
  initial: HouseholdResponse;
  currentUserId: string;
  /** The owner's alert email threshold (_specs/owner-alerts.md). */
  initialThreshold?: AlertThreshold;
  /**
   * `@neo/tools` `REMOTE_ACCESS_TOOLS` as `{ id, name }`, for the expected-tools editor
   * (_specs/signals.md). The page must pass this — `@neo/tools` is not client-safe to import
   * here (it pulls in `node:crypto`; see `components/household/DevicesSection.tsx`).
   */
  remoteAccessTools?: RemoteAccessToolOption[];
}) {
  const { toast } = useToast();
  const [home, setHome] = useState(initial);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [threshold, setThreshold] = useState<AlertThreshold>(initialThreshold);
  const isOwner = home.role === "owner";

  async function refresh() {
    const res = await fetch("/api/household", { headers: { Accept: "application/json" } });
    if (res.ok) setHome((await res.json()) as HouseholdResponse);
  }

  async function invite(kind: "email" | "link") {
    if (busy) return;
    setBusy(true);
    setLink(null);
    try {
      const res = await fetch("/api/household/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(kind === "email" ? { kind, email } : { kind }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not create the invite."));
      const body = (await res.json()) as CreateInviteResponse;
      if (kind === "link") {
        setLink(body.url);
        toast({ intent: "success", title: "Invite link created — copy it now. Neo will not show it again." });
      } else {
        setEmail("");
        toast({ intent: "success", title: `Invite sent to ${body.invite.email}` });
      }
      await refresh();
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not create the invite." });
    } finally {
      setBusy(false);
    }
  }

  async function saveThreshold(next: AlertThreshold) {
    if (busy || next === threshold) return;
    const previous = threshold;
    setThreshold(next);
    setBusy(true);
    try {
      const res = await fetch("/api/settings/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ threshold: next }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not save your alert setting."));
      toast({ intent: "success", title: "Alert emails updated" });
    } catch (err) {
      setThreshold(previous);
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not save your alert setting." });
    } finally {
      setBusy(false);
    }
  }

  async function resend(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/household/invites/${encodeURIComponent(id)}/resend`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not resend the invite."));
      toast({ intent: "success", title: "Invite sent again. The earlier link no longer works." });
      await refresh();
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not resend the invite." });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (pending.kind === "leave") {
        const res = await fetch("/api/household/leave", { method: "POST" });
        if (!res.ok) throw new Error(await errorMessage(res, "Could not leave the household."));
        window.location.assign("/dashboard");
        return;
      }
      const url =
        pending.kind === "remove"
          ? `/api/household/members/${encodeURIComponent(pending.userId)}`
          : pending.kind === "device"
            ? `/api/household/devices/${encodeURIComponent(pending.deviceId)}`
            : `/api/household/invites/${encodeURIComponent(pending.inviteId)}`;
      const res = await fetch(url, { method: "DELETE" });
      // A device someone else already removed is gone either way.
      if (!res.ok && !(pending.kind === "device" && res.status === 404)) {
        throw new Error(
          pending.kind === "device" && res.status === 403
            ? "You can only remove devices that protect you."
            : await errorMessage(res, "Something went wrong."),
        );
      }
      toast({ intent: "success", title: pending.kind === "revoke" ? "Invite revoked" : `${pending.label} was removed` });
      await refresh();
      setPending(null);
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  }

  const owner = home.members.find((m) => m.role === "owner");
  const ownerName = owner?.name || "The household owner";

  const dialog =
    pending?.kind === "remove"
      ? {
          title: `Remove ${pending.label}?`,
          body: "Their chats in this household are deleted, and their desktop sign-ins and devices stop working. Checks they ran stay in your household history. They get an email and can keep using Neo on their own.",
          confirmLabel: "Remove",
        }
      : pending?.kind === "revoke"
        ? { title: "Revoke this invite?", body: `The link for ${pending.label} will stop working.`, confirmLabel: "Revoke" }
        : pending?.kind === "device"
          ? {
              title: `Remove ${pending.label}?`,
              body: isOwner
                ? `It stops reporting scam warnings${pending.memberName ? ` for ${pending.memberName}` : ""}. To protect it again, add it with a new enrollment code.`
                : `It stops reporting scam warnings to your household. ${ownerName} will be told.`,
              confirmLabel: "Remove",
            }
          : pending?.kind === "leave"
          ? {
              title: `Leave ${home.name}?`,
              body: "Your chats in this household are deleted. Checks you ran stay with the household. Next time you use Neo you get a household of your own.",
              confirmLabel: "Leave household",
            }
          : null;


  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{home.name}</h1>
        <p className="text-sm text-muted">
          {isOwner
            ? "Invite family members so Neo can look out for them too. You see the checks they run; their chats stay private. Everyone shares the household's monthly checks."
            : `${owner?.name ?? "The owner"} manages this household and can see the checks you run. Your chats stay private.`}
        </p>
      </header>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4" aria-hidden="true" />
          Members
        </h2>
        <ul className="divide-y divide-border">
          {home.members.map((m) => {
            const label = m.name || m.email || "Member";
            return (
              <li key={m.userId} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {label}
                    {m.userId === currentUserId ? <span className="ml-2 text-xs font-normal text-muted">(you)</span> : null}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {m.role === "owner" ? "Owner" : "Member"}
                    {m.email && m.email !== label ? ` · ${m.email}` : ""}
                  </div>
                </div>
                {isOwner && m.role !== "owner" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPending({ kind: "remove", userId: m.userId, label })}
                    aria-label={`Remove ${label}`}
                    className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {!isOwner ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setPending({ kind: "leave" })}
            className="mt-4 min-h-11 rounded-xl border border-border px-4 text-sm font-medium text-red-700 hover:bg-surface-2 disabled:opacity-50 dark:text-red-300"
          >
            Leave household
          </button>
        ) : null}
      </section>

      <DevicesSection
        devices={home.devices}
        enrollmentCodes={home.enrollmentCodes}
        members={home.members}
        currentUserId={currentUserId}
        isOwner={isOwner}
        busy={busy}
        setBusy={setBusy}
        refresh={refresh}
        onRemove={(d) => setPending({ kind: "device", deviceId: d.id, label: d.name, memberName: d.memberName })}
        remoteAccessTools={remoteAccessTools}
      />

      {isOwner ? (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <UserPlus className="size-4" aria-hidden="true" />
            Invite someone
          </h2>
          <form
            className="flex flex-col gap-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) void invite("email");
            }}
          >
            <label htmlFor="invite-email" className="sr-only">
              Email address
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              autoComplete="off"
              placeholder="name@example.com"
              className="min-h-11 flex-1 rounded-xl border border-border bg-bg px-3 text-sm"
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              <Send className="size-4" aria-hidden="true" />
              Send invite
            </button>
          </form>
          <p className="mt-2 text-xs text-muted">Only someone signed in with that address can accept it. Invites expire after 7 days.</p>

          <div className="mt-5 border-t border-border pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => void invite("link")}
              className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              <Link2 className="size-4" aria-hidden="true" />
              Create an invite link
            </button>
            <p className="mt-2 text-xs text-muted">
              For someone without an email address you can type easily. Send it by text or in person: anyone who opens it while signed in can
              join, once.
            </p>
            {link ? (
              <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
                <p className="mb-2 text-sm font-medium text-amber-900 dark:text-amber-100">
                  Copy this link now. It will not be shown again, and anyone who has it can join your household.
                </p>
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-lg bg-bg px-3 py-2 text-xs">{link}</code>
                  <CopyButton text={link} />
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {isOwner ? (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Mail className="size-4" aria-hidden="true" />
            Pending invites
          </h2>
          {home.invites.length === 0 ? (
            <p className="text-sm text-muted">No pending invites.</p>
          ) : (
            <ul className="divide-y divide-border">
              {home.invites.map((i) => {
                const label = i.email ?? `Link invite neo_inv_${i.tokenPrefix}…`;
                return (
                  <li key={i.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{label}</div>
                      <div className="text-xs text-muted">
                        created {relativeTime(i.createdAt)} · {expiresIn(i.expiresAt)}
                      </div>
                    </div>
                    {i.kind === "email" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void resend(i.id)}
                        className="min-h-11 rounded-xl px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                      >
                        Resend
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPending({ kind: "revoke", inviteId: i.id, label })}
                      aria-label={`Revoke invite for ${label}`}
                      className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {isOwner ? (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <fieldset>
            <legend className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <BellRing className="size-4" aria-hidden="true" />
              Alert emails
            </legend>
            <p className="mb-3 text-xs text-muted">
              Neo alerts you when a member checks something dangerous or someone joins or leaves. Choose what reaches your inbox.
            </p>
            <div className="space-y-1">
              {THRESHOLD_OPTIONS.map((o) => (
                <label key={o.value} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                  <input
                    type="radio"
                    name="alert-threshold"
                    value={o.value}
                    checked={threshold === o.value}
                    disabled={busy}
                    onChange={() => void saveThreshold(o.value)}
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span>
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block text-xs text-muted">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        title={dialog?.title ?? ""}
        body={dialog?.body ?? ""}
        confirmLabel={dialog?.confirmLabel ?? "Confirm"}
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
