"use client";

import type { ModelFamily, RoutingPreference, Tier } from "@neo/core";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { PreferenceModels, RoutingSettings } from "@/lib/routing-types";
import { useToast } from "./toast-context";

const PREFERENCES: { id: RoutingPreference; label: string; description: string }[] = [
  { id: "cost", label: "Cost", description: "Leans toward smaller, cheaper models. Hard questions still get a capable one." },
  { id: "balanced", label: "Balanced", description: "Matches the model to how hard each question is. Recommended." },
  { id: "intelligence", label: "Intelligence", description: "Leans toward larger models, even for simple questions." },
];

const TIER_LABELS: Record<Tier, string> = {
  small: "Simple",
  medium: "Typical",
  large: "Hard",
};

type Status = { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string };

function cardClass(selected: boolean, disabled = false): string {
  return `block rounded-xl border p-4 text-sm ${
    disabled
      ? "cursor-not-allowed border-border opacity-60"
      : selected
        ? "cursor-pointer border-accent bg-accent-soft ring-1 ring-accent"
        : "cursor-pointer border-border bg-surface hover:bg-surface-2"
  } has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent`;
}

export function RoutingSettingsView({ initial, models }: { initial: RoutingSettings; models: PreferenceModels }) {
  const [saved, setSaved] = useState(initial);
  const [preference, setPreference] = useState<RoutingPreference>(initial.preference);
  const [family, setFamily] = useState<ModelFamily>(initial.family);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const { toast } = useToast();

  const dirty = preference !== saved.preference || family !== saved.family;

  async function save() {
    setBusy(true);
    setStatus({ kind: "idle" });
    // Send only what changed: a stored family that has since been disabled must not block a preference change.
    const body: { preference?: RoutingPreference; family?: ModelFamily } = {};
    if (preference !== saved.preference) body.preference = preference;
    if (family !== saved.family) body.family = family;
    try {
      const res = await fetch("/api/settings/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as RoutingSettings;
      setSaved(next);
      setPreference(next.preference);
      setFamily(next.family);
      setStatus({ kind: "saved" });
      toast({ intent: "success", title: "Model settings saved", description: "Your next message uses them." });
    } catch {
      setStatus({ kind: "error", message: "Could not save your model settings. Try again." });
      toast({ intent: "error", title: "Could not save model settings" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-semibold">Model routing</h1>
      <p className="mt-1 text-sm text-muted">
        Neo picks a model for each message based on how hard it looks. Choose which family of models to use and whether to
        lean toward lower cost or more capability. This setting is yours; other household members choose their own.
      </p>

      <section aria-labelledby="family-heading" className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 id="family-heading" className="text-sm font-semibold">
          Model family
        </h2>
        <div role="radiogroup" aria-labelledby="family-heading" className="mt-3 grid gap-2 sm:grid-cols-2">
          {saved.families.map((f) => {
            const selected = family === f.id;
            return (
              <label key={f.id} className={cardClass(selected, !f.enabled)} data-testid={`family-${f.id}`}>
                <input
                  type="radio"
                  name="family"
                  value={f.id}
                  checked={selected}
                  disabled={!f.enabled || busy}
                  onChange={() => setFamily(f.id)}
                  className="sr-only"
                />
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{f.label}</span>
                  {!f.enabled ? <span className="text-xs text-muted">Coming soon</span> : null}
                </span>
                <span className="mt-1 block text-xs text-muted">{f.ladder.map((r) => r.displayName).join(" · ")}</span>
                {f.caveat ? (
                  <span className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    {f.caveat}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="preference-heading" className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 id="preference-heading" className="text-sm font-semibold">
          Preference
        </h2>
        <div role="radiogroup" aria-labelledby="preference-heading" className="mt-3 space-y-2">
          {PREFERENCES.map((p) => {
            const selected = preference === p.id;
            return (
              <label key={p.id} className={cardClass(selected)} data-testid={`preference-${p.id}`}>
                <input
                  type="radio"
                  name="preference"
                  value={p.id}
                  checked={selected}
                  disabled={busy}
                  onChange={() => setPreference(p.id)}
                  className="sr-only"
                />
                <span className="font-medium">{p.label}</span>
                <span className="mt-0.5 block text-muted">{p.description}</span>
                <ul className="mt-2 space-y-0.5 text-xs">
                  {models[family][p.id].map((m) => (
                    <li key={m.tier} className="flex gap-2">
                      <span className="w-16 shrink-0 text-muted">{TIER_LABELS[m.tier]}</span>
                      <span>
                        {m.displayName} <span className="text-muted">· {m.effort} effort</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </label>
            );
          })}
        </div>
      </section>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="min-h-9 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <p role="status" className={`text-sm ${status.kind === "error" ? "text-red-600 dark:text-red-400" : "text-muted"}`}>
          {status.kind === "saved" ? "Saved." : status.kind === "error" ? status.message : ""}
        </p>
      </div>
    </div>
  );
}
