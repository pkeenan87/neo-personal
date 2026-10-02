"use client";

import { Check, ChevronDown, KeyRound, Monitor, Pencil, Plus, Puzzle, ShieldCheck, Trash2, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import type { HouseholdSummary } from "@/lib/dashboard-types";
import type {
  CreateEnrollmentCodeResponse,
  DeviceItem,
  DevicePlatform,
  EnrollmentCodeItem,
  ExpectedToolItem,
} from "@/lib/household-types";
import type { SetExpectedToolsResponse } from "@/lib/signal-types";
import { CopyButton } from "../CopyButton";
import { useToast } from "../toast-context";

export type { ExpectedToolItem };

/** Device names are 1–64 characters (_specs/device-enrollment.md). */
export const DEVICE_NAME_MAX = 64;

/**
 * `{ id, name }` from `@neo/tools` `REMOTE_ACCESS_TOOLS`. `@neo/tools` pulls in `node:crypto`
 * and other Node-only modules at import time (`packages/tools/src/lists.ts`, re-exported from
 * the package root), so it isn't safe to import directly in this client component. The owning
 * server page must import `REMOTE_ACCESS_TOOLS` itself and pass `{ id, name }` down.
 */
export interface RemoteAccessToolOption {
  id: string;
  name: string;
}

/**
 * Store listing links (_specs/browser-extension.md "Store links"), inlined at build time.
 * Unset shows "coming soon" for that browser. The Windows app link works the same way
 * (`NEXT_PUBLIC_WINDOWS_AGENT_URL`, _specs/desktop-agent.md), as does the Mac app
 * (`NEXT_PUBLIC_MAC_AGENT_URL`, _specs/desktop-agent-macos.md).
 */
const CHROME_EXTENSION_URL = process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;
const FIREFOX_EXTENSION_URL = process.env.NEXT_PUBLIC_FIREFOX_EXTENSION_URL;
const WINDOWS_AGENT_URL = process.env.NEXT_PUBLIC_WINDOWS_AGENT_URL;
const MAC_AGENT_URL = process.env.NEXT_PUBLIC_MAC_AGENT_URL;

const QUICK_ASSIST_NOTE = "Quick Assist never shows who connected, so Neo still alerts you about every Quick Assist session.";

function extensionLink(url: string | undefined, label: string) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">
      {label}
    </a>
  ) : (
    <>{label} (coming soon)</>
  );
}

const PEER_ID_MAX = 64;
const PEER_ID_RE = /^[A-Za-z0-9 _.@-]+$/;
const MAX_EXPECTED_TOOLS = 10;
const MAX_PEER_IDS = 10;

function expectedTools(d: DeviceItem): ExpectedToolItem[] {
  return d.expectedTools ?? [];
}

/** Remounts the editor whenever the server's saved set changes, so local drafts resync for free. */
function expectedToolsKey(d: DeviceItem): string {
  return expectedTools(d)
    .map((t) => `${t.toolId}:${t.peerIds.join(",")}`)
    .join("|");
}

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
  remoteAccessTools = [],
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
  /** `@neo/tools` `REMOTE_ACCESS_TOOLS`, passed by the server page as `{ id, name }` (not client-safe to import). */
  remoteAccessTools?: RemoteAccessToolOption[];
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
      <li key={d.id} className="py-3">
        <div className="flex items-center gap-3">
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
        </div>
        {d.kind === "desktop_agent" ? (
          <ExpectedToolsSection
            key={`${d.id}:${expectedToolsKey(d)}`}
            device={d}
            isOwner={isOwner}
            toolList={remoteAccessTools}
            busy={busy}
            setBusy={setBusy}
            refresh={refresh}
          />
        ) : null}
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
          {codeExpiry(r.expiresAt)} · single use. Install Neo — {extensionLink(CHROME_EXTENSION_URL, "Chrome")},{" "}
          {extensionLink(FIREFOX_EXTENSION_URL, "Firefox")}, or the app for {extensionLink(WINDOWS_AGENT_URL, "Windows")} or{" "}
          {extensionLink(MAC_AGENT_URL, "Mac")} — choose{" "}
          <em>I have an enrollment code</em>, and enter this code.
        </p>
        <p className="mt-2 text-xs text-muted">
          Install the Windows or Mac app in person, on the computer itself. Don&apos;t ask a relative to download it over the phone:
          that is exactly what a scammer would ask them to do.
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
          These devices report scam warnings about you to {owner ? memberLabel(owner) : "the household owner"}. Besides a regular
          check-in, they report only specific signals — a scam page&apos;s domain, a remote-access tool, a remote session, or a
          permission grant — never everything they see.
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
        Devices protected by Neo report scam warnings to you. Add a device below to get an enrollment code and the
        install links for their browser.
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

// ─── Expected remote-access tools (_specs/signals.md) ──────────────────────

function ExpectedToolsSection({
  device,
  isOwner,
  toolList,
  busy,
  setBusy,
  refresh,
}: {
  device: DeviceItem;
  isOwner: boolean;
  toolList: RemoteAccessToolOption[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const saved = expectedTools(device);
  if (!isOwner && saved.length === 0) return null;
  return isOwner ? (
    <OwnerExpectedTools device={device} saved={saved} toolList={toolList} busy={busy} setBusy={setBusy} refresh={refresh} />
  ) : (
    <MemberExpectedTools device={device} saved={saved} />
  );
}

function disclosureSummary(count: number): string {
  return `Expected remote-access tools${count > 0 ? ` (${count})` : ""}`;
}

function MemberExpectedTools({ device, saved }: { device: DeviceItem; saved: ExpectedToolItem[] }) {
  return (
    <details className="mt-2 rounded-xl border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-xl px-3 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        {disclosureSummary(saved.length)}
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-3">
        <p className="text-xs text-muted">
          Your household owner marked these as expected. Neo still tells you when an unknown person connects.{" "}
          {QUICK_ASSIST_NOTE}
        </p>
        <ul className="space-y-1.5" aria-label={`Expected remote-access tools for ${device.name}`}>
          {saved.map((t) => (
            <li key={t.toolId} className="text-sm">
              <span className="font-medium">{t.name}</span>
              {t.peerIds.length > 0 ? <span className="text-xs text-muted"> · {t.peerIds.join(", ")}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function OwnerExpectedTools({
  device,
  saved,
  toolList,
  busy,
  setBusy,
  refresh,
}: {
  device: DeviceItem;
  saved: ExpectedToolItem[];
  toolList: RemoteAccessToolOption[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<ExpectedToolItem[]>(saved);
  const [addToolId, setAddToolId] = useState("");
  const [peerInputs, setPeerInputs] = useState<Record<string, string>>({});
  const [peerErrors, setPeerErrors] = useState<Record<string, string>>({});

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const available = toolList.filter((t) => !draft.some((d) => d.toolId === t.id));
  const memberLabelText = device.memberName || "this member";

  function addTool() {
    const tool = toolList.find((t) => t.id === addToolId);
    if (!tool || draft.length >= MAX_EXPECTED_TOOLS) return;
    setDraft((prev) => [...prev, { toolId: tool.id, name: tool.name, peerIds: [] }]);
    setAddToolId("");
  }

  function removeTool(toolId: string) {
    setDraft((prev) => prev.filter((t) => t.toolId !== toolId));
    setPeerInputs((prev) => ({ ...prev, [toolId]: "" }));
    setPeerErrors((prev) => ({ ...prev, [toolId]: "" }));
  }

  function addPeerId(toolId: string, toolName: string) {
    const raw = (peerInputs[toolId] ?? "").trim();
    if (!raw) return;
    if (raw.length > PEER_ID_MAX || !PEER_ID_RE.test(raw)) {
      setPeerErrors((prev) => ({
        ...prev,
        [toolId]: `A peer ID is up to ${PEER_ID_MAX} characters: letters, numbers, spaces, or _ . @ -`,
      }));
      return;
    }
    let atLimit = false;
    setDraft((prev) =>
      prev.map((t) => {
        if (t.toolId !== toolId) return t;
        if (t.peerIds.includes(raw)) return t;
        if (t.peerIds.length >= MAX_PEER_IDS) {
          atLimit = true;
          return t;
        }
        return { ...t, peerIds: [...t.peerIds, raw] };
      }),
    );
    if (atLimit) {
      setPeerErrors((prev) => ({ ...prev, [toolId]: `${toolName} already has ${MAX_PEER_IDS} peer IDs.` }));
      return;
    }
    setPeerInputs((prev) => ({ ...prev, [toolId]: "" }));
    setPeerErrors((prev) => ({ ...prev, [toolId]: "" }));
  }

  function removePeerId(toolId: string, peerId: string) {
    setDraft((prev) => prev.map((t) => (t.toolId === toolId ? { ...t, peerIds: t.peerIds.filter((p) => p !== peerId) } : t)));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/household/devices/${encodeURIComponent(device.id)}/expected-tools`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ tools: draft.map((t) => ({ toolId: t.toolId, peerIds: t.peerIds })) }),
      });
      if (res.status === 404) {
        await refresh();
        throw new Error("That device was already removed.");
      }
      if (res.status === 403) throw new Error("You can only manage tools for devices in your household.");
      if (!res.ok) {
        const body = await readError(res);
        throw new Error(
          body.code === "unknown_tool"
            ? "One of those tools isn't available anymore. Remove it and try again."
            : body.error || "Could not save expected tools.",
        );
      }
      const body = (await res.json()) as SetExpectedToolsResponse;
      setDraft(body.tools);
      toast({ intent: "success", title: "Expected tools updated" });
      await refresh();
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not save expected tools." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-2 rounded-xl border border-border">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-xl px-3 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        {disclosureSummary(saved.length)}
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">
        <p className="text-xs text-muted">
          Add the tools you use to help {memberLabelText}, with your own ID, so your sessions don&apos;t alert. Neo still tells
          you when an unknown person connects. {QUICK_ASSIST_NOTE}
        </p>

        {draft.length === 0 ? (
          <p className="text-xs text-muted">No tools marked as expected.</p>
        ) : (
          <ul className="space-y-2">
            {draft.map((t) => (
              <li key={t.toolId} className="rounded-lg border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeTool(t.toolId)}
                    aria-label={`Remove ${t.name} from expected tools`}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                {t.peerIds.length > 0 ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`Peer IDs for ${t.name}`}>
                    {t.peerIds.map((p) => (
                      <li key={p} className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs">
                        {p}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => removePeerId(t.toolId, p)}
                          aria-label={`Remove peer ID ${p} for ${t.name}`}
                          className="text-muted hover:text-fg disabled:opacity-50"
                        >
                          <X className="size-3" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {t.peerIds.length < MAX_PEER_IDS ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <label htmlFor={`peer-${device.id}-${t.toolId}`} className="sr-only">
                      Peer ID for {t.name}
                    </label>
                    <input
                      id={`peer-${device.id}-${t.toolId}`}
                      value={peerInputs[t.toolId] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setPeerInputs((prev) => ({ ...prev, [t.toolId]: value }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addPeerId(t.toolId, t.name);
                        }
                      }}
                      placeholder="Your peer or session ID"
                      maxLength={PEER_ID_MAX}
                      autoComplete="off"
                      className="min-h-9 min-w-0 flex-1 basis-32 rounded-lg border border-border bg-bg px-2 text-xs"
                    />
                    <button
                      type="button"
                      disabled={busy || !(peerInputs[t.toolId] ?? "").trim()}
                      onClick={() => addPeerId(t.toolId, t.name)}
                      className="min-h-9 shrink-0 rounded-lg border border-border px-2 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
                    >
                      Add ID
                    </button>
                  </div>
                ) : null}
                {peerErrors[t.toolId] ? (
                  <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
                    {peerErrors[t.toolId]}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {draft.length < MAX_EXPECTED_TOOLS && available.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor={`add-tool-${device.id}`} className="sr-only">
              Add an expected tool
            </label>
            <select
              id={`add-tool-${device.id}`}
              value={addToolId}
              onChange={(e) => setAddToolId(e.target.value)}
              disabled={busy}
              className="min-h-9 min-w-0 flex-1 basis-40 rounded-lg border border-border bg-bg px-2 text-xs disabled:opacity-50"
            >
              <option value="">Add a tool…</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !addToolId}
              onClick={addTool}
              className="min-h-9 shrink-0 rounded-lg border border-border px-2 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        ) : draft.length < MAX_EXPECTED_TOOLS && toolList.length === 0 ? (
          <p className="text-xs text-muted">The tool list isn&apos;t available right now.</p>
        ) : null}

        <div className="flex items-center gap-2 border-t border-border pt-2">
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => void save()}
            className="min-h-9 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg disabled:opacity-50"
          >
            Save
          </button>
          {dirty ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(saved);
                setPeerErrors({});
              }}
              className="min-h-9 rounded-lg px-3 text-xs text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
