import { useState } from "react";
import { defangDomain, errorMessage, RATING_COPY } from "../lib/copy";
import type { AgentClient, CheckUrlResult } from "../lib/types";

type State = { status: "idle" } | { status: "checking" } | { status: "done"; result: CheckUrlResult } | { status: "error"; message: string };

/** "Check a link": paste an address, see the same ratings as the browser extension. */
export function CheckLinkView({ client }: { client: AgentClient }) {
  const [link, setLink] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function check(e: React.FormEvent) {
    e.preventDefault();
    const url = link.trim();
    if (!url) return;
    setState({ status: "checking" });
    const r = await client.checkUrl(url);
    if (r.ok) setState({ status: "done", result: r });
    else setState({ status: "error", message: r.code === "invalid_request" ? "Paste a full web address that starts with http:// or https://." : errorMessage(r.code, r.error) });
  }

  return (
    <main className="page">
      <h1>Check a link</h1>
      <form onSubmit={check}>
        <label>
          Paste a link to check
          <input type="text" value={link} onChange={(e) => setLink(e.target.value)} autoFocus spellCheck={false} />
        </label>
        <button type="submit" className="primary" disabled={state.status === "checking" || !link.trim()}>
          Check
        </button>
      </form>
      {state.status === "checking" && <p>Checking…</p>}
      {state.status === "error" && <p className="muted">{state.message}</p>}
      {state.status === "done" && (
        <div className="result">
          <strong style={{ color: RATING_COPY[state.result.rating].color }}>{RATING_COPY[state.result.rating].label}</strong>
          <div>{defangDomain(state.result.domain)}</div>
          {state.result.rating === "no_known_problems" && <div>That doesn&apos;t guarantee it&apos;s safe.</div>}
          {state.result.reasons.length > 0 && (
            <ul>
              {state.result.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}
