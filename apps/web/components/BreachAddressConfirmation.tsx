"use client";
import Link from "next/link";
import { useState } from "react";

export function BreachAddressConfirmation({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "confirmed" | "invalid" | "signin" | "error">("idle");
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token);

  async function confirm(): Promise<void> {
    if (!validToken || state === "busy") return;
    setState("busy");
    try {
      const response = await fetch("/api/settings/breaches/addresses/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.status === 401 || response.status === 403) {
        setState("signin");
        return;
      }
      if (!response.ok) {
        setState("invalid");
        return;
      }
      setState("confirmed");
      window.history.replaceState({}, "", "/settings/breaches/verify");
    } catch {
      setState("error");
    }
  }

  if (!validToken) return <p role="alert">The confirmation link is missing or invalid.</p>;
  if (state === "confirmed") return <section aria-live="polite"><h1 className="text-2xl font-semibold">Address confirmed</h1><p role="status" className="mt-3 text-sm text-muted">Neo will include this address in its next weekly breach check.</p><Link className="mt-4 inline-block text-accent underline" href="/settings/breaches">View breach monitoring</Link></section>;
  return (
    <section>
      <h1 className="text-2xl font-semibold">Confirm this additional address</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">This one-time link expires after 24 hours. Sign in to the same Neo account that requested it, then confirm. Opening this page alone does not consume the link.</p>
      <button type="button" onClick={() => void confirm()} disabled={state === "busy"} className="mt-5 min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-50">{state === "busy" ? "Confirming…" : "Confirm address"}</button>
      {state === "signin" ? (
        <div className="mt-3 text-sm">
          <p role="alert">Sign in to the same Neo account that requested this address, then return to this link.</p>
          <Link className="mt-2 inline-block text-accent underline" href={`/api/auth/signin?callbackUrl=${encodeURIComponent(`/settings/breaches/verify?token=${token}`)}`}>
            Sign in to the same Neo account
          </Link>
        </div>
      ) : null}
      {state === "invalid" ? (
        <div className="mt-3 text-sm">
          <p role="alert">This confirmation link is invalid, expired, or already used.</p>
          <p className="mt-2">Request a new confirmation link from <Link className="text-accent underline" href="/settings/breaches">breach monitoring in Settings</Link>.</p>
        </div>
      ) : null}
      {state === "error" ? <p role="alert" className="mt-3 text-sm">Could not confirm this address. Try again.</p> : null}
    </section>
  );
}
