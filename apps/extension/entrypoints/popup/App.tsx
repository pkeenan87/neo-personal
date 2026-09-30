import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { sendToBackground } from "@/lib/messages.js";
import type { CheckUrlResponse } from "@/lib/api.js";
import type { ExtensionState } from "@/lib/types.js";
import { defangDomain } from "@/lib/format.js";

type CheckState = { status: "idle" } | { status: "checking" } | { status: "done"; result: CheckUrlResponse } | { status: "error"; message: string };

function formatLastSeen(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

const RATING_COPY: Record<CheckUrlResponse["rating"], { label: string; color: string }> = {
  dangerous: { label: "Dangerous", color: "#c0392b" },
  suspicious: { label: "Suspicious", color: "#b8860b" },
  no_known_problems: { label: "No known problems", color: "#2f6f4f" },
  unknown: { label: "Couldn't check", color: "#6b727c" },
};

export function App() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [link, setLink] = useState("");
  const [hostAccess, setHostAccess] = useState<boolean | null>(null);
  const paramUrl = useMemo(() => new URLSearchParams(location.search).get("check"), []);
  const [check, setCheck] = useState<CheckState>(paramUrl ? { status: "checking" } : { status: "idle" });

  useEffect(() => {
    sendToBackground<ExtensionState>({ type: "get-state" }).then(setState).catch(() => {});
    browser.permissions
      .contains({ origins: ["<all_urls>"] })
      .then(setHostAccess)
      .catch(() => setHostAccess(null));
  }, []);

  async function requestHostAccess() {
    const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
    setHostAccess(granted);
  }

  async function runCheck(url: string) {
    setCheck({ status: "checking" });
    const result = await sendToBackground<{ ok: true; data: CheckUrlResponse } | { ok: false; error?: string }>({ type: "check-url", url });
    if (result.ok) setCheck({ status: "done", result: result.data });
    else setCheck({ status: "error", message: result.error ?? "Couldn't reach Neo." });
  }

  useEffect(() => {
    if (!paramUrl) return;
    sendToBackground<{ ok: true; data: CheckUrlResponse } | { ok: false; error?: string }>({ type: "check-url", url: paramUrl })
      .then((result) => {
        if (result.ok) setCheck({ status: "done", result: result.data });
        else setCheck({ status: "error", message: result.error ?? "Couldn't reach Neo." });
      })
      .catch(() => setCheck({ status: "error", message: "Couldn't reach Neo." }));
  }, [paramUrl]);

  async function checkThisPage() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) void runCheck(tab.url);
  }

  if (!state) return <main style={{ padding: 16 }}>Loading…</main>;

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>Neo</h1>

      {hostAccess === false && (
        <p style={{ background: "#fff4e5", color: "#8a5b00", padding: 8, borderRadius: 6, marginBottom: 8 }}>
          Neo can&apos;t check pages. Allow access to all sites.{" "}
          <button type="button" onClick={requestHostAccess}>
            Allow
          </button>
        </p>
      )}

      {state.connection === "enrolled" && state.household ? (
        <p style={{ margin: "0 0 12px", color: "#4a5361" }}>
          Protecting <strong>{state.household.memberName ?? "this browser"}</strong>&apos;s browser for{" "}
          <strong>{state.household.householdName}</strong>.<br />
          Last check-in: {formatLastSeen(state.lastHeartbeatAt)}.
        </p>
      ) : (
        <p style={{ margin: "0 0 12px", color: "#c0392b" }}>
          This browser is not connected to a household. <a href={browser.runtime.getURL("/options.html")}>Set up Neo</a>
        </p>
      )}

      <button type="button" onClick={checkThisPage} style={{ width: "100%", padding: "8px 12px", marginBottom: 8 }}>
        Check this page
      </button>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) void runCheck(link.trim());
        }}
      >
        <input
          type="text"
          placeholder="Paste a link to check"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", marginBottom: 8 }}
        />
      </form>

      {check.status === "checking" && <p>Checking…</p>}
      {check.status === "error" && <p style={{ color: "#6b727c" }}>{check.message}</p>}
      {check.status === "done" && (
        <div style={{ padding: 10, borderRadius: 6, background: "#f4f5f7", marginBottom: 8 }}>
          <strong style={{ color: RATING_COPY[check.result.rating].color }}>{RATING_COPY[check.result.rating].label}</strong>
          <div style={{ color: "#4a5361" }}>{defangDomain(check.result.domain)}</div>
          {check.result.rating === "no_known_problems" && <div style={{ color: "#4a5361" }}>That doesn&apos;t guarantee it&apos;s safe.</div>}
          {check.result.reasons.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {check.result.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <hr style={{ margin: "12px 0", border: "none", borderTop: "1px solid #e5e7eb" }} />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <a href={browser.runtime.getURL("/options.html")}>Settings</a>
        <a href="https://www.neoshield.dev" target="_blank" rel="noreferrer">
          Neo on the web
        </a>
      </div>
    </main>
  );
}
