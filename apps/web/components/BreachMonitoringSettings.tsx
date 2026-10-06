"use client";
import { useState, type FormEvent } from "react";
import type { BreachStatusAddress, BreachStatusSnapshot } from "@/lib/server/breach-monitoring/status-service";

function statusLabel(status: BreachStatusAddress["status"]): string {
  switch (status) {
    case "pending": return "Awaiting email confirmation";
    case "clean": return "No current breach found";
    case "breached": return "Breach found";
    case "stale": return "Check overdue";
    case "never-checked": return "Not checked yet";
    case "failed": return "Check failed";
  }
}
function summaryLabel(status: BreachStatusSnapshot["status"]): string {
  switch (status) {
    case "clean": return "Clean";
    case "breached": return "Breached";
    case "stale": return "Stale";
    case "never-checked": return "Never checked";
    case "failed": return "Failed";
  }
}
function dateLabel(value: string | null): string {
  if (!value) return "Not yet checked";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable";
}
function observationHistoryLabel(address: BreachStatusAddress, observation: BreachStatusAddress["observations"][number]): string {
  if (observation.retiredAt) return "Retired by HIBP";
  if (address.status === "failed") return "Previously observed; latest check failed";
  if (address.status === "stale") return "Previously observed; last successful check is overdue";
  const lastSuccess = address.lastSuccessfulCheckAt ? Date.parse(address.lastSuccessfulCheckAt) : NaN;
  const lastSeen = Date.parse(observation.lastSeenAt);
  if (address.status === "clean" && Number.isFinite(lastSuccess) && lastSeen < lastSuccess) return "Not returned in the latest check; retained in history";
  if (address.status === "breached" && Number.isFinite(lastSuccess) && lastSeen >= lastSuccess) return "Returned in the latest successful check";
  return "Previously observed";
}

export function BreachMonitoringSettings({ initial }: { initial: BreachStatusSnapshot | null }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh(): Promise<void> {
    const response = await fetch("/api/settings/breaches", { cache: "no-store" });
    if (!response.ok) throw new Error("status unavailable");
    setSnapshot(await response.json() as BreachStatusSnapshot);
  }

  async function addAddress(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/breaches/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 202) {
        setEmail("");
        setMessage("Confirmation email sent. Check that inbox and confirm while signed in to this Neo account.");
        await refresh();
      } else if (body.error === "address_limit_reached") {
        setMessage("You can monitor up to five additional addresses.");
      } else if (body.error === "verification_rate_limited") {
        setMessage("Too many confirmation emails for this address. Try again later.");
      } else if (body.error === "address_already_verified") {
        setMessage("That address is already being monitored.");
      } else {
        setMessage("Could not send a confirmation email. Check the address and try again.");
      }
    } catch {
      setMessage("Breach monitoring is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAddress(address: BreachStatusAddress): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/settings/breaches/addresses/${encodeURIComponent(address.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("delete failed");
      await refresh();
      setMessage("Additional address removed.");
    } catch {
      setMessage("Could not remove that address. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-3xl font-semibold tracking-tight">Breach monitoring</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Neo checks your verified sign-in email and any additional addresses you confirm. Checks run weekly; this page never starts a provider request.
      </p>
      {!snapshot ? (
        <p role="alert" className="mt-5 rounded-xl border border-border bg-surface p-4 text-sm">Breach monitoring is currently unavailable.</p>
      ) : (
        <>
          <section aria-label="Breach monitoring status" className="mt-5 rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <p aria-label="Breach monitoring status line" className="font-semibold" data-testid="breach-status-line">
              Breach monitoring: {summaryLabel(snapshot.status)}
            </p>
            <p className="mt-2 text-sm text-muted">Latest successful check: {dateLabel(snapshot.lastSuccessfulCheckAt)}</p>
            {snapshot.pendingCount > 0 ? <p className="mt-1 text-sm text-muted">{snapshot.pendingCount} address{snapshot.pendingCount === 1 ? "" : "es"} awaiting confirmation. Unverified addresses are not checked.</p> : null}
          </section>

          <section aria-labelledby="monitored-addresses-heading" className="mt-6 rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <h2 id="monitored-addresses-heading" className="text-lg font-semibold">Your monitored addresses</h2>
            <ul className="mt-3 divide-y divide-border">
              {snapshot.addresses.map((address) => {
                const activeBreaches = address.observations.filter((observation) => !observation.retiredAt);
                const retiredBreaches = address.observations.filter((observation) => Boolean(observation.retiredAt));
                return (
                  <li key={address.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-all font-medium">{address.email}</h3>
                        <p className="mt-1 text-xs text-muted">{address.source === "sign_in" ? "Verified sign-in address" : "Additional address"}</p>
                        <p className="mt-2 text-sm">{statusLabel(address.status)}</p>
                        {address.status !== "pending" ? <p className="mt-1 text-xs text-muted">Last attempt: {dateLabel(address.lastCheckedAt)} · Last successful: {dateLabel(address.lastSuccessfulCheckAt)}</p> : null}
                      </div>
                      {address.source === "extra" ? (
                        <button type="button" disabled={busy} onClick={() => void removeAddress(address)} aria-label={`Remove ${address.email}`} className="min-h-10 rounded-lg border border-border-strong px-3 text-sm hover:bg-surface-2 disabled:opacity-50">Remove</button>
                      ) : null}
                    </div>
                    {activeBreaches.length ? (
                      <ul className="mt-3 space-y-3">
                        {activeBreaches.map((breach) => (
                          <li key={breach.breachName} className="rounded-xl bg-surface-2 p-3 text-sm">
                            <p className="font-medium">{breach.breachName}</p>
                            <p className="mt-1 text-xs text-muted">{observationHistoryLabel(address, breach)}</p>
                            <p className="mt-1 text-xs text-muted">{breach.domain ? `${breach.domain} · ` : ""}{breach.breachDate ? `Breach date ${breach.breachDate} · ` : ""}First seen {dateLabel(breach.firstSeenAt)}</p>
                            <p className="mt-1 text-xs text-muted">Data types: {breach.dataClasses.join(", ") || "Not specified"}</p>
                            {breach.dataClasses.some((value) => value.toLowerCase() === "passwords") ? <p className="mt-2">Change that password and anywhere you reused it. Turn on two-factor authentication.</p> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {retiredBreaches.length ? <p className="mt-3 text-xs text-muted">{retiredBreaches.length} retired breach record{retiredBreaches.length === 1 ? "" : "s"} retained for your history.</p> : null}
                  </li>
                );
              })}
              {snapshot.addresses.length === 0 ? <li className="py-4 text-sm text-muted">No verified addresses are being monitored yet.</li> : null}
            </ul>
          </section>

          <section aria-labelledby="add-address-heading" className="mt-6 rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <h2 id="add-address-heading" className="text-lg font-semibold">Add another address</h2>
            <p className="mt-2 text-sm text-muted">Up to five additional addresses. Neo sends a one-time confirmation link; the address is not checked until you confirm it while signed in.</p>
            <form onSubmit={(event) => void addAddress(event)} className="mt-4 flex flex-col gap-3 sm:flex-row">
              <label className="min-w-0 flex-1 text-sm font-medium">
                <span className="sr-only">Additional email address</span>
                <input type="email" required maxLength={254} autoComplete="email" aria-label="Additional email address" value={email} onChange={(event) => setEmail(event.target.value)} className="min-h-11 w-full rounded-lg border border-border-strong bg-bg px-3" />
              </label>
              <button type="submit" disabled={busy || !email.trim()} className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-50">{busy ? "Sending…" : "Send confirmation"}</button>
            </form>
            {message ? <p role="status" aria-live="polite" className="mt-3 text-sm text-muted">{message}</p> : null}
          </section>

          <p className="mt-5 text-xs text-muted">Breach data provided by <a href={snapshot.attribution.url} rel="noreferrer" className="text-accent underline">{snapshot.attribution.label}</a>, used under {snapshot.attribution.license}. Address details are encrypted in Neo and deleted with the address or when you leave the household.</p>
        </>
      )}
    </div>
  );
}
