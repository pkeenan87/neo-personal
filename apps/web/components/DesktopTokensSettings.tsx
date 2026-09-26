"use client";

import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type {
  CreateDesktopTokenResponse,
  DesktopTokenListItem,
  DesktopTokenListResponse,
} from "@/lib/desktop-token-types";
import { CopyButton } from "./CopyButton";
import { relativeTime } from "./ConversationSidebar";
import { useToast } from "./toast-context";

export function DesktopTokensSettingsView({ initial }: { initial: DesktopTokenListItem[] }) {
  const { toast } = useToast();
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState("Omarchy bar");
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/settings/desktop-tokens", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("list failed");
    const body = (await res.json()) as DesktopTokenListResponse;
    setTokens(body.tokens);
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    setRevealed(null);
    try {
      const res = await fetch("/api/settings/desktop-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || "Could not create token");
      }
      const body = (await res.json()) as CreateDesktopTokenResponse;
      setRevealed(body.token);
      await refresh();
      toast({ intent: "success", title: "Token created — copy it now. Neo will not show it again." });
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not create token" });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string, label: string) {
    if (busy) return;
    if (!window.confirm(`Revoke “${label}”? The Omarchy plugin (or any other client) using it will stop working.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/settings/desktop-tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not revoke token");
      if (revealed?.includes(tokens.find((t) => t.id === id)?.tokenPrefix ?? "___")) setRevealed(null);
      await refresh();
      toast({ intent: "success", title: "Token revoked" });
    } catch (err) {
      toast({ intent: "error", title: err instanceof Error ? err.message : "Could not revoke token" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Desktop tokens</h1>
        <p className="text-sm text-muted">
          Personal access tokens let the Omarchy NeoShield bar (and other desktop clients) talk to Neo without a browser
          session. Each token is shown once when you create it — store it in{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">~/.config/omarchy-neo/config.json</code> via{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">omarchy-neo setup</code>.
        </p>
      </header>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Plus className="size-4" aria-hidden="true" />
          Create a token
        </h2>
        <label className="mb-2 block text-xs font-medium text-muted" htmlFor="token-name">
          Label
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            className="min-h-11 flex-1 rounded-xl border border-border bg-bg px-3 text-sm"
            placeholder="Omarchy bar"
          />
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
            className="min-h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            Create token
          </button>
        </div>

        {revealed ? (
          <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
            <p className="mb-2 text-sm font-medium text-amber-900 dark:text-amber-100">
              Copy this token now. It will not be shown again.
            </p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-bg px-3 py-2 text-xs">{revealed}</code>
              <CopyButton text={revealed} />
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="size-4" aria-hidden="true" />
          Active tokens
        </h2>
        {tokens.length === 0 ? (
          <p className="text-sm text-muted">No desktop tokens yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-muted">
                    neo_dt_{t.tokenPrefix}… · created {relativeTime(t.createdAt)}
                    {t.lastUsedAt ? ` · last used ${relativeTime(t.lastUsedAt)}` : " · never used"}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(t.id, t.name)}
                  aria-label={`Revoke ${t.name}`}
                  className="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
