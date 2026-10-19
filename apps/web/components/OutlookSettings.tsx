"use client";
import { useState } from "react";
import type { OutlookView } from "@/lib/server/outlook/service";

const NOTICES: Record<string, string> = {
  connected: "Your Outlook.com mailbox is connected.",
  denied: "You declined access, so nothing was connected.",
  invalid_state: "That connection attempt expired or did not match this browser. Start again.",
  failed: "Could not finish connecting. Try again.",
};
const STATUS: Record<string, string> = { connected: "Connected", reauth_required: "Needs reconnecting", paused: "Paused", disconnected: "Not connected" };
const ACTION: Record<string, string> = { forward_to: "forwards", redirect_to: "redirects", forward_as_attachment_to: "forwards as an attachment" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "not yet");

export function OutlookSettings({ initial, notice, isOwner }: { initial: OutlookView; notice: string | null; isOwner: boolean }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [removed, setRemoved] = useState(false);

  async function connect() {
    setBusy(true); setError(false);
    try {
      const res = await fetch("/api/connectors/outlook/start", { method: "POST" });
      const body: unknown = await res.json();
      if (!res.ok || !body || typeof body !== "object" || !("authorizeUrl" in body) || typeof body.authorizeUrl !== "string") throw new Error("start failed");
      window.location.assign(body.authorizeUrl);
    } catch { setError(true); setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError(false);
    try {
      const res = await fetch("/api/connectors/outlook", { method: "DELETE" });
      if (!res.ok) throw new Error("disconnect failed");
      setView({ ...view, connector: null }); setRemoved(true);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  const c = view.connector;
  const active = view.findings.filter((f) => f.state === "active");
  return <div className="mx-auto w-full max-w-2xl">
    <h1 className="text-3xl font-semibold tracking-tight">Outlook</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted">
      Connect a personal Outlook.com mailbox with read-only access. Neo checks your inbox rules for forwarding to outside
      addresses and looks for sign-in alerts from Google, Microsoft, Apple, Facebook, Amazon and PayPal. It never sends, changes
      or deletes mail, rules or settings. Neo audits inbox rules only and cannot verify account-level forwarding.
    </p>
    {notice && NOTICES[notice] ? <p role="status" className="mt-4 text-sm">{NOTICES[notice]}</p> : null}
    {error ? <p role="alert" className="mt-4 text-sm">Something went wrong. Try again.</p> : null}

    {view.mode === "off" ? (
      <p className="mt-6 rounded-xl border border-border bg-surface p-4 text-sm">The Outlook connector is not available on this server.</p>
    ) : c ? (
      <section className="mt-6 rounded-xl border border-border bg-surface p-4 text-sm">
        <p><strong>{STATUS[c.status] ?? c.status}</strong>{c.displayAddress ? ` · ${c.displayAddress}` : ""}</p>
        <p className="mt-1 text-muted">Last rule check: {when(c.lastAuditAt)}. Last inbox check: {when(c.lastPollAt)}.</p>
        {c.status === "reauth_required" ? <p className="mt-2">Microsoft needs you to sign in again. Reconnect to resume checks.</p> : null}
        <div className="mt-4 flex gap-3">
          {c.status === "reauth_required" ? <button type="button" onClick={connect} disabled={busy} className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-50">Reconnect</button> : null}
          <button type="button" onClick={disconnect} disabled={busy} className="min-h-11 rounded-lg border border-border px-4 text-sm font-semibold disabled:opacity-50">Disconnect</button>
        </div>
      </section>
    ) : (
      <button type="button" onClick={connect} disabled={busy} className="mt-6 min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-50">Connect Outlook.com</button>
    )}

    {removed ? (
      <p role="status" className="mt-4 text-sm">
        Disconnected: Neo deleted its stored access. To remove Neo&apos;s access at Microsoft, visit{" "}
        <a className="underline" href={view.appAccessUrl} rel="noreferrer">account.microsoft.com/privacy/app-access</a>.
      </p>
    ) : null}

    {active.length ? (
      <section className="mt-6">
        <h2 className="text-lg font-semibold">Forwarding rules to review</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {active.map((f) => <li key={f.id} className="rounded-xl border border-border bg-surface p-3">
            An enabled inbox rule {ACTION[f.action] ?? "forwards"} mail to {f.destinationDomain ? `an outside address at ${f.destinationDomain}` : "a destination Neo could not read"}. Found {when(f.observedAt)}.
            Review it in Outlook under Settings, Mail, Rules.
          </li>)}
        </ul>
      </section>
    ) : null}

    {isOwner && view.household?.length ? (
      <section className="mt-6">
        <h2 className="text-lg font-semibold">Household</h2>
        <p className="mt-1 text-sm text-muted">You see connection status and last check time only. Forwarding findings reach you as alerts.</p>
        <ul className="mt-2 space-y-1 text-sm">
          {view.household.map((m) => <li key={m.userId}>{m.name}: {STATUS[m.status] ?? m.status}, last check {when(m.lastCheckAt)}</li>)}
        </ul>
      </section>
    ) : null}
  </div>;
}
