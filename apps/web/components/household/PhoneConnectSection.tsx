"use client";

import { useEffect, useState, type FormEvent } from "react";

interface ChannelItem {
  id: string;
  display: string;
  verified: boolean;
  verificationExpiresAt: string | null;
}

type ApiBody = { error?: string; channels?: ChannelItem[] };

const field = "min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm";
const primary = "min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50";

/**
 * "Connect a phone (SMS)" on a member's page (_specs/v2-m3-cutover.md section 5). Enter an international
 * number, receive a six-digit code, confirm it. Only a confirmed phone can text Neo. Shown only while the
 * Twilio channel is enabled. Codes are mock-only until A2P registration, so none is actually delivered yet.
 */
export function PhoneConnectSection({ memberId, memberName }: { memberId: string; memberName: string }) {
  const base = `/api/household/protected-members/${encodeURIComponent(memberId)}/channels`;
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [phone, setPhone] = useState("");
  const [pendingPhone, setPendingPhone] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  async function call(url: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<ChannelItem[]> {
    const res = await fetch(url, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = (await res.json().catch(() => ({}))) as ApiBody;
    if (!res.ok) throw new Error(data.error || "That didn't work. Try again.");
    return data.channels ?? [];
  }

  useEffect(() => {
    let live = true;
    call(base, "GET")
      .then((rows) => live && setChannels(rows))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "That didn't work. Try again." });
    } finally {
      setBusy(false);
    }
  }

  function sendCode(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      setChannels(await call(base, "POST", { phone }));
      setPendingPhone(phone);
      setPhone("");
      setCode("");
      setMessage({ kind: "info", text: "We sent a six-digit code. It expires in 10 minutes." });
    });
  }

  function confirm(e: FormEvent) {
    e.preventDefault();
    if (!pendingPhone) return;
    void run(async () => {
      setChannels(await call(`${base}/verify`, "POST", { phone: pendingPhone, code }));
      setPendingPhone(null);
      setCode("");
      setMessage({ kind: "info", text: "Phone connected." });
    });
  }

  function remove(id: string) {
    void run(async () => {
      setChannels(await call(`${base}/${encodeURIComponent(id)}`, "DELETE"));
      setMessage({ kind: "info", text: "Phone disconnected." });
    });
  }

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface p-5 shadow-sm" aria-labelledby="phone-heading">
      <h2 id="phone-heading" className="text-sm font-semibold">
        Connect a phone (SMS)
      </h2>
      <p className="text-xs text-muted">{memberName} can text Neo from a connected phone. Neo only answers numbers confirmed with a code.</p>
      {channels.length > 0 && (
        <ul className="space-y-2">
          {channels.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{c.display}</span>
              <span className="text-xs text-muted">{c.verified ? "Connected" : "Waiting for the code"}</span>
              <button type="button" disabled={busy} onClick={() => remove(c.id)} className="min-h-11 text-xs text-muted underline disabled:opacity-50">
                {c.verified ? "Disconnect" : "Cancel"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={sendCode} className="space-y-2">
        <label className="block space-y-1 text-sm">
          <span>Phone number with country code</span>
          <input type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+15551234567" required className={field} />
        </label>
        <button type="submit" disabled={busy || phone.trim() === ""} className={primary}>
          Send code
        </button>
      </form>
      {pendingPhone && (
        <form onSubmit={confirm} className="space-y-2">
          <label className="block space-y-1 text-sm">
            <span>Six-digit code</span>
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className={field} />
          </label>
          <button type="submit" disabled={busy || !/^\d{6}$/.test(code)} className={primary}>
            Confirm
          </button>
        </form>
      )}
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "text-sm text-red-700 dark:text-red-300" : "text-sm text-muted"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
