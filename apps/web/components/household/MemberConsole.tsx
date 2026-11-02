"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  NOTIFY_SEVERITIES,
  type MemberDetailResponse,
  type MemberModeName,
  type MemberRoleName,
  type NotifySeverity,
} from "@/lib/member-types";

const ROLE_LABEL: Record<MemberRoleName, string> = { owner: "Owner", adult: "Adult", child: "Child", elder: "Elder" };
const SEVERITY_LABEL: Record<NotifySeverity, string> = { low: "Low and above", medium: "Medium and above", high: "High and above", critical: "Critical only" };
const MAX_HELPERS = 10;

async function send(url: string, method: "PATCH" | "PUT", body: unknown): Promise<MemberDetailResponse> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Partial<MemberDetailResponse> & { error?: string };
  if (!res.ok) throw new Error(data.error || "That didn't save. Try again.");
  return data as MemberDetailResponse;
}

const field = "min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm";
const primary = "min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50";

/**
 * The owner's page for one member (_specs/v2-m1-elder.md section 8). Each section saves on its own
 * through the protected-members routes; the server answers with the fresh detail, which replaces
 * what is shown, so the summary always matches what is stored.
 */
export function MemberConsole({ initial }: { initial: MemberDetailResponse }) {
  const [detail, setDetail] = useState(initial);
  const m = detail.member;
  const [name, setName] = useState(m.displayName);
  const [role, setRole] = useState<MemberRoleName>(m.role);
  const [mode, setMode] = useState<MemberModeName>(m.mode);
  const [helpers, setHelpers] = useState<string[]>(m.helperMemberIds);
  const [contact, setContact] = useState("");
  const [helpersNotifyAt, setHelpersNotifyAt] = useState<NotifySeverity>(detail.notify.helpersNotifyAt);
  const [ownersNotifyAt, setOwnersNotifyAt] = useState<NotifySeverity>(detail.notify.ownersNotifyAt);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const base = `/api/household/protected-members/${encodeURIComponent(m.id)}`;
  const turningElderOff = m.mode === "elder" && mode !== "elder";

  async function save(section: string, url: string, method: "PATCH" | "PUT", body: unknown, done: string) {
    setBusy(section);
    setMessage(null);
    try {
      const next = await send(url, method, body);
      setDetail(next);
      setName(next.member.displayName);
      setRole(next.member.role);
      setMode(next.member.mode);
      setHelpers(next.member.helperMemberIds);
      setContact("");
      setHelpersNotifyAt(next.notify.helpersNotifyAt);
      setOwnersNotifyAt(next.notify.ownersNotifyAt);
      setMessage({ kind: "ok", text: done });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "That didn't save. Try again." });
    } finally {
      setBusy(null);
    }
  }

  const submit = (section: string, url: string, method: "PATCH" | "PUT", body: unknown, done: string) => (e: FormEvent) => {
    e.preventDefault();
    void save(section, url, method, body, done);
  };

  const toggleHelper = (id: string) =>
    setHelpers((cur) => (cur.includes(id) ? cur.filter((h) => h !== id) : cur.length >= MAX_HELPERS ? cur : [...cur, id]));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="space-y-1">
        <p className="text-sm">
          <Link href="/settings/household" className="text-accent hover:underline">
            ‹ Household
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{m.displayName}</h1>
        <p className="text-sm text-muted">{m.hasAccount ? "Has a Neo account." : "Has no Neo account; helper emails go to the address below."}</p>
      </header>

      <div role="status" aria-live="polite" className={message ? `rounded-xl border p-3 text-sm ${message.kind === "error" ? "border-red-300/60 text-red-700 dark:text-red-300" : "border-border"}` : "sr-only"}>
        {message?.text ?? ""}
      </div>

      <form
        onSubmit={submit("profile", base, "PATCH", { displayName: name, role: m.role === "owner" ? undefined : role }, "Saved.")}
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <h2 className="text-sm font-semibold">Name and role</h2>
        <label className="block space-y-1 text-sm">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className={field} />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Role</span>
          {m.role === "owner" ? (
            <p className="min-h-11 content-center text-sm text-muted">Owner (the owner role can&apos;t be changed here)</p>
          ) : (
            <select value={role} onChange={(e) => setRole(e.target.value as MemberRoleName)} className={field}>
              {(["adult", "child", "elder"] as const).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          )}
        </label>
        <button type="submit" disabled={busy !== null} className={primary}>
          {busy === "profile" ? "Saving…" : "Save"}
        </button>
      </form>

      <form onSubmit={submit("mode", base, "PATCH", { mode }, "Mode saved.")} className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">Protection mode</legend>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="radio" name="mode" value="standard" checked={mode === "standard"} onChange={() => setMode("standard")} />
            <span>
              <strong>Standard</strong>: Neo's usual rules.
            </span>
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="radio" name="mode" value="elder" checked={mode === "elder"} disabled={detail.isLastOwner} onChange={() => setMode("elder")} />
            <span>
              <strong>Elder</strong>: stricter rules for scams, and helpers are emailed straight away.
              {detail.isLastOwner ? " Not available for the only owner." : ""}
            </span>
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm text-muted">
            <input type="radio" name="mode" value="child" disabled />
            <span>
              <strong>Child</strong>: coming soon.
            </span>
          </label>
        </fieldset>
        {turningElderOff && <p className="text-sm text-muted">Every owner will get an email saying Elder mode was turned off.</p>}
        {m.mode === "elder" && m.helperMemberIds.length === 0 && (
          <p className="text-sm text-amber-800 dark:text-amber-200">No helpers are set. Only owners will be told when something looks wrong.</p>
        )}
        <button type="submit" disabled={busy !== null || mode === m.mode} className={primary}>
          {busy === "mode" ? "Saving…" : "Save mode"}
        </button>
      </form>

      <form
        onSubmit={submit("helpers", base, "PATCH", { helperMemberIds: helpers }, "Helpers saved.")}
        className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <fieldset className="space-y-1">
          <legend className="mb-1 text-sm font-semibold">Helpers</legend>
          <p className="text-xs text-muted">Helpers are emailed when {m.displayName} is in Elder or Child mode and something serious happens. Up to {MAX_HELPERS}.</p>
          {detail.others.length === 0 && <p className="text-sm text-muted">There is nobody else in the household yet.</p>}
          {detail.others.map((o) => (
            <label key={o.id} className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" checked={helpers.includes(o.id)} onChange={() => toggleHelper(o.id)} disabled={!helpers.includes(o.id) && helpers.length >= MAX_HELPERS} />
              <span>
                {o.displayName}
                {o.hasAccount ? "" : " (no account)"}
              </span>
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={busy !== null} className={primary}>
          {busy === "helpers" ? "Saving…" : "Save helpers"}
        </button>
      </form>

      {!m.hasAccount && (
        <form
          onSubmit={submit("contact", base, "PATCH", { contact }, "Email saved.")}
          className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm"
        >
          <h2 className="text-sm font-semibold">Helper email</h2>
          <p className="text-xs text-muted">
            {m.displayName} has no account, so alerts go to this address when they are a helper. {detail.contactHint ? `Saved: ${detail.contactHint}.` : "None saved yet."}
          </p>
          <label className="block space-y-1 text-sm">
            <span>Email address</span>
            <input type="email" value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="off" className={field} />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy !== null || contact.trim() === ""} className={primary}>
              {busy === "contact" ? "Saving…" : "Save email"}
            </button>
            {m.hasContact && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void save("contact", base, "PATCH", { contact: null }, "Email removed.")}
                className="min-h-11 rounded-xl border border-border px-4 text-sm"
              >
                Remove
              </button>
            )}
          </div>
        </form>
      )}

      <form
        onSubmit={submit("policy", `${base}/policy`, "PUT", { helpersNotifyAt, ownersNotifyAt }, "Notify limits saved.")}
        className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm"
      >
        <h2 className="text-sm font-semibold">Who is told, and when</h2>
        <label className="block space-y-1 text-sm">
          <span>Email helpers about</span>
          <select value={helpersNotifyAt} onChange={(e) => setHelpersNotifyAt(e.target.value as NotifySeverity)} className={field}>
            {NOTIFY_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span>Email owners about</span>
          <select value={ownersNotifyAt} onChange={(e) => setOwnersNotifyAt(e.target.value as NotifySeverity)} className={field}>
            {NOTIFY_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy !== null || (helpersNotifyAt === detail.notify.helpersNotifyAt && ownersNotifyAt === detail.notify.ownersNotifyAt)}
          className={primary}
        >
          {busy === "policy" ? "Saving…" : "Save limits"}
        </button>
      </form>

      <section aria-labelledby="policy-summary" className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 id="policy-summary" className="mb-2 text-sm font-semibold">
          How Neo treats {m.displayName}
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {detail.policySummary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
