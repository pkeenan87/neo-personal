"use client";

import { MonitorSmartphone, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import type { DeviceAuthDecideResponse, DeviceAuthDeviceInput } from "@/lib/desktop-auth-types";
import type { DevicePlatform } from "@/lib/household-types";

export interface DesktopAuthorizeRequest {
  clientName: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied";
  /** Set for a monitoring request (a device that reports scam warnings); null for full access. */
  device: DeviceAuthDeviceInput | null;
  /** The household a monitoring device reports to; null for full access. */
  householdName: string | null;
}

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

export function DesktopAuthorizeView({
  code,
  invalidInput,
  request,
  unavailable,
  account,
}: {
  /** Normalized user code from the URL, or null when none was given. */
  code: string | null;
  /** A code was given but is not shaped like one. */
  invalidInput: boolean;
  request: DesktopAuthorizeRequest | null;
  unavailable: boolean;
  account: { email: string; name: string };
}) {
  const [decision, setDecision] = useState<"approved" | "denied" | null>(request && request.status !== "pending" ? request.status : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  async function decide(approve: boolean) {
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desktop/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ userCode: code, approve }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || "Something went wrong.");
      }
      const body = (await res.json()) as DeviceAuthDecideResponse;
      setDecision(body.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const who = account.email ? `${account.name} (${account.email})` : account.name;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MonitorSmartphone className="size-6 text-accent" aria-hidden="true" />
          Authorize a device
        </h1>
        <p className="text-sm text-muted">
          A desktop client (for example the NeoShield bar on Omarchy) wants to use Neo as <strong className="text-fg">{who}</strong>.
        </p>
      </header>

      {!code ? (
        <form
          className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
          method="get"
          onSubmit={(e) => {
            if (!typed.trim()) e.preventDefault();
          }}
        >
          <label htmlFor="user-code" className="mb-2 block text-sm font-medium">
            Enter the code shown in your terminal
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="user-code"
              name="code"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={16}
              placeholder="XXXX-XXXX"
              className="min-h-11 flex-1 rounded-xl border border-border bg-bg px-3 font-mono text-base tracking-widest uppercase"
            />
            <button type="submit" className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg">
              Continue
            </button>
          </div>
          {invalidInput ? <p className="mt-3 text-sm text-red-700 dark:text-red-300">That does not look like a code. It has eight letters and digits.</p> : null}
        </form>
      ) : null}

      {code && unavailable ? (
        <p role="alert" className="rounded-2xl border border-border bg-surface p-5 text-sm shadow-sm">
          Neo cannot check that code right now. Please try again in a moment.
        </p>
      ) : null}

      {code && !unavailable && !request ? (
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <p className="text-sm">
            The code <span className="font-mono tracking-widest">{code}</span> is not valid or has expired. Codes last ten minutes. Run the sign-in
            again on your device and use the new code.
          </p>
          <a href="/desktop/authorize" className="mt-3 inline-block text-sm text-accent underline">
            Enter a different code
          </a>
        </div>
      ) : null}

      {code && request && decision === null ? (
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Code</dt>
            <dd className="font-mono text-base tracking-widest">{code}</dd>
            <dt className="text-muted">Device</dt>
            <dd className="font-medium">{request.device ? request.device.name : request.clientName}</dd>
            {request.device ? (
              <>
                <dt className="text-muted">Platform</dt>
                <dd>
                  {PLATFORM_LABEL[request.device.platform]} {request.device.kind === "browser_extension" ? "browser extension" : "desktop app"}
                </dd>
              </>
            ) : null}
            <dt className="text-muted">Grants</dt>
            <dd data-testid="grant">
              {request.device ? (
                <>
                  Permission to report scam warnings from this device to <strong>{request.householdName ?? "your household"}</strong>. It cannot
                  read your checks or chats.
                </>
              ) : (
                <>Full access to your Neo account.</>
              )}
            </dd>
          </dl>
          <p className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
            {request.device
              ? "Only approve if you just started this on your own device and the code matches. You can remove the device under Settings → Household."
              : "Only approve if you just started this sign-in yourself and the code matches your terminal. Approving gives that device the same access to your household as you have, until you revoke it under Settings → Desktop."}
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(true)}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              <ShieldX className="size-4" aria-hidden="true" />
              Deny
            </button>
          </div>
        </div>
      ) : null}

      {decision === "approved" ? (
        <div role="status" className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-5 text-sm shadow-sm">
          <p className="font-medium">Device authorized.</p>
          <p className="mt-1 text-muted">You can close this tab. Your terminal will finish signing in on its own within a few seconds.</p>
        </div>
      ) : null}
      {decision === "denied" ? (
        <div role="status" className="rounded-2xl border border-border bg-surface p-5 text-sm shadow-sm">
          <p className="font-medium">Sign-in declined.</p>
          <p className="mt-1 text-muted">Nothing was granted. If you did not start this, no action is needed.</p>
        </div>
      ) : null}
    </div>
  );
}
