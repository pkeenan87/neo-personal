"use client";

import { Check, KeyRound, Monitor, Pencil, Plus, Puzzle, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import type { HouseholdSummary } from "@/lib/dashboard-types";
import type { CreateEnrollmentCodeResponse, DeviceItem, DevicePlatform, EnrollmentCodeItem } from "@/lib/household-types";
import { CopyButton } from "../CopyButton";
import { useToast } from "../toast-context";

/** Device names are 1–64 characters (_specs/device-enrollment.md). */
export const DEVICE_NAME_MAX = 64;

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "3 hours ago", in words, for status lines people read out loud. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

/** "Tuesday" within the last week, otherwise "Sep 12". */
export function sinceLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "a while ago";
  if (now - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function codeExpiry(iso: string, now: number = Date.now()): string {
  const minutes = Math.ceil((new Date(iso).getTime() - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "Expired";
  if (minutes < 60) return `Expires in ${plural(minutes, "minute")}`;
  return `Expires in ${plural(Math.round(minutes / 60), "hour")}`;
}

function statusLine(d: DeviceItem): { text: string; warn: boolean } {
  if (d.status === "never_seen") return { text: "Waiting for first check-in", warn: false };
  if (d.status === "offline") return { text: `Offline since ${sinceLabel(d.lastSeenAt ?? d.createdAt)}`, warn: true };
  return { text: `Last checked in ${d.lastSeenAt ? timeAgo(d.lastSeenAt) : "just now"}`, warn: false };
}

async function readError(res: Response): Promise<{ error?: string; code?: string }> {
  return (await res.json().catch(() => ({}))) as { error?: string; code?: string };
}

function memberLabel(m: HouseholdMember): string {
  return m.name || m.email || "Member";
}

type HouseholdMember = HouseholdSummary["members"][number];

type Revealed = CreateEnrollmentCodeResponse & { userId: string };

export function DevicesSection({
  devices,
  enrollmentCodes,
  members,
  currentUserId,
  isOwner,
  busy,
  setBusy,
  refresh,
  onRemove,
}: {
  devices: DeviceItem[];
  enrollmentCodes: EnrollmentCodeItem[];
  members: HouseholdMember[];
  currentUserId: string;
  isOwner: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  refresh: () => Promise<void>;
  /** Opens the parent's confirmation dialog; the parent sends the DELETE. */
  onRemove: (device: DeviceItem) => void;
}) {
  const { toast } = useToast();
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  // A member sees only their own devices (the API filters); with none, there is nothing to show.
  if (!isOwner && devices.length === 0) return null;

  async function addDevice(m: HouseholdMember) {
    if (busy) return;
    setBusy(true);
    setRevealed(null);
    const label = memberLabel(m);
    try {
      const res = await fetch(`/api/household/members/${encodeURIComponent(m.userId)}/enrollment-codes`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const body = await readError(res);
        if (res.status === 409 && body.code === "code_limit") {
          throw new Error("Your household has too many unused enrollment codes. Cancel one before adding another device.");
        }
        if (res.status === 409 && body.code === "device_limit") {
          throw new Error("Your household has reached its device limit. Remove a device before adding another.");
        }
        if (res.status === 404) {
          await refresh();
          throw new Error(`${label} is no longer in this household.`);
        }
        throw new Error(body.error || "Could not create an enrollment code.");
      }
      const body = (await res.json()) as CreateEnrollmentCodeResponse;
      setRevealed({ ...body, userId: m.userId });
      toast({ intent: "success", title: "Enrollment code created — Neo will not show it again." });
      await refresh();
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not create an enrollment code." });
    } finally {
      setBusy(false);
    }
  }

  async function cancelCode(c: EnrollmentCodeItem) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/household/enrollment-codes/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error((await readError(res)).error || "Could not cancel the code.");
      if (revealed?.id === c.id) setRevealed(null);
      toast({ intent: "success", title: "Enrollment code cancelled" });
      await refresh();
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not cancel the code." });
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    if (!editing || busy) return;
    const name = editing.name.trim();
    if (name.length < 1 || name.length > DEVICE_NAME_MAX) {
      toast({ intent: "error", title: `Device names are 1 to ${DEVICE_NAME_MAX} characters.` });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/household/devices/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 404) {
        setEditing(null);
        await refresh();
        throw new Error("That device was already removed.");
      }
      if (!res.ok) throw new Error((await readError(res)).error || "Could not rename the device.");
      setEditing(null);
      toast({ intent: "success", title: "Device renamed" });
      await refresh();
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not rename the device." });
    } finally {
      setBusy(false);
    }
  }

  function deviceRow(d: DeviceItem) {
    const Icon = d.kind === "browser_extension" ? Puzzle : Monitor;
    const kindLabel = `${d.kind === "browser_extension" ? "Browser extension" : "PC app"} · ${PLATFORM_LABEL[d.platform] ?? d.platform}`;
    const status = statusLine(d);
    const isEditing = editing?.id === d.id;
    return (
      <li key={d.id} className="flex items-center gap-3 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted" title={kindLabel}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
        {isEditing ? (
          <form
            className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <label htmlFor={`device-name-${d.id}`} className="sr-only">
              Device name
            </label>
            <input
              id={`device-name-${d.id}`}
              value={editing.name}
              onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(null);
              }}
              maxLength={DEVICE_NAME_MAX}
              autoComplete="off"
              autoFocus
              className="min-h-11 min-w-0 flex-1 basis-40 rounded-xl border border-border bg-bg px-3 text-sm"
            />
            <div className="flex shrink-0 gap-1">
              <button
                type="submit"
                disabled={busy || !editing.name.trim()}
                aria-label="Save name"
                className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
              >
                <Check className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(null)}
                aria-label="Cancel renaming"
                className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{d.name}</div>
              <div className="truncate text-xs text-muted">{kindLabel}</div>
              <div
                className={`flex min-w-0 items-center gap-1 text-xs ${status.warn ? "text-amber-700 dark:text-amber-300" : "text-muted"}`}
              >
                {status.warn ? <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                <span className="truncate">{status.text}</span>
              </div>
            </div>
            {isOwner ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing({ id: d.id, name: d.name })}
                aria-label={`Rename ${d.name}`}
                className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
              >
                <Pencil className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => onRemove(d)}
              aria-label={`Remove ${d.name}`}
              className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </>
        )}
      </li>
    );
  }

  function codeReveal(r: Revealed, label: string) {
    return (
      <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
        <p className="mb-2 text-sm font-medium text-amber-900 dark:text-amber-100">
          Enrollment code for {label}. Copy it now; it will not be shown again.
        </p>
        <div className="flex items-center gap-2">
          <code
            aria-label="Enrollment code"
            className="min-w-0 flex-1 break-all rounded-lg bg-bg px-3 py-2 font-mono text-xl font-semibold tracking-widest sm:text-2xl"
          >
            {r.code}
          </code>
          <CopyButton text={r.code} label="Copy enrollment code" />
        </div>
        <p className="mt-2 text-xs text-muted">
          {codeExpiry(r.expiresAt)} · single use. Install Neo on their browser or PC, choose <em>I have an enrollment code</em>, and
          enter this code.
        </p>
        <button
          type="button"
          onClick={() => setRevealed(null)}
          className="mt-3 min-h-11 rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2"
        >
          Done
        </button>
      </div>
    );
  }

  if (!isOwner) {
    const owner = members.find((m) => m.role === "owner");
    return (
      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4" aria-hidden="true" />
          Your devices
        </h2>
        <p className="mb-2 text-xs text-muted">
          These devices report scam warnings about you to {owner ? memberLabel(owner) : "the household owner"}. They send only a
          check-in with their app version and time.
        </p>
        <ul className="divide-y divide-border">{devices.map(deviceRow)}</ul>
      </section>
    );
  }

  // Group by member in the Members order; any device for someone not listed goes last under its own name.
  const known = new Set(members.map((m) => m.userId));
  const extra = new Map<string, HouseholdMember>();
  for (const d of devices) {
    if (!known.has(d.userId) && !extra.has(d.userId)) {
      extra.set(d.userId, { userId: d.userId, name: d.memberName, email: null, role: "member" });
    }
  }
  const groups = [...members, ...extra.values()];

  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4" aria-hidden="true" />
        Devices
      </h2>
      <p className="mb-2 text-xs text-muted">
        Devices protected by Neo report scam warnings to you. The Neo browser extension and PC app are coming soon.
      </p>
      <div className="divide-y divide-border">
        {groups.map((m) => {
          const label = memberLabel(m);
          const own = devices.filter((d) => d.userId === m.userId);
          const codes = enrollmentCodes.filter((c) => c.userId === m.userId);
          return (
            <div key={m.userId} role="group" aria-label={`${label}'s devices`} className="py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
                  {label}
                  {m.userId === currentUserId ? <span className="ml-2 text-xs font-normal text-muted">(you)</span> : null}
                </h3>
                {known.has(m.userId) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void addDevice(m)}
                    aria-label={`Add a device for ${label}`}
                    className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-border px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Add a device
                  </button>
                ) : null}
              </div>
              {own.length === 0 ? (
                <p className="mt-1 text-xs text-muted">No devices yet.</p>
              ) : (
                <ul className="divide-y divide-border">{own.map(deviceRow)}</ul>
              )}
              {revealed?.userId === m.userId ? codeReveal(revealed, label) : null}
              {codes.length > 0 ? (
                <ul className="mt-2 space-y-1" aria-label={`Pending enrollment codes for ${label}`}>
                  {codes.map((c) => (
                    <li key={c.id} className="flex items-center gap-3">
                      <KeyRound className="size-4 shrink-0 text-muted" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">
                        Unused enrollment code · {codeExpiry(c.expiresAt).toLowerCase()}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void cancelCode(c)}
                        aria-label={`Cancel enrollment code for ${label}`}
                        className="min-h-11 shrink-0 rounded-xl px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
