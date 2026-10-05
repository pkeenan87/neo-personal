"use client";
import { useState } from "react";

export function DigestSettings({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saved, setSaved] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  async function save() {
    setBusy(true); setStatus("idle");
    try {
      const res = await fetch("/api/settings/digest", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error("save failed");
      const next: unknown = await res.json();
      if (!next || typeof next !== "object" || !("enabled" in next) || typeof next.enabled !== "boolean") throw new Error("invalid response");
      setSaved(next.enabled); setEnabled(next.enabled); setStatus("saved");
    } catch { setStatus("error"); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto w-full max-w-2xl">
    <h1 className="text-3xl font-semibold tracking-tight">Weekly digest</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted">
      Get your security checks from the past week on Mondays at 14:00 UTC. Owners also receive aggregate household alerts
      and member-device health, without member verdict details. Empty weeks are skipped.
    </p>
    <p className="mt-3 text-sm text-muted">
      This controls only your digest, separately from alert emails. Owners start enabled and members start disabled;
      a role change resets that default. You can also unsubscribe from any digest.
    </p>
    <label className="mt-6 flex min-h-11 items-center gap-3 rounded-xl border border-border bg-surface p-4">
      <input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); setStatus("idle"); }} />
      Email me a weekly security digest
    </label>
    <div className="mt-5 flex items-center gap-3">
      <button type="button" onClick={save} disabled={busy || enabled === saved} aria-busy={busy}
        className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg disabled:opacity-50">
        {busy ? "Saving…" : "Save"}
      </button>
      <p role={status === "error" ? "alert" : "status"} aria-atomic="true" className="text-sm text-muted">
        {status === "saved" ? "Saved." : status === "error" ? "Could not save your digest preference. Try again." : ""}
      </p>
    </div>
  </div>;
}
