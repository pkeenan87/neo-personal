import { useEffect, useState } from "react";
import { errorMessage, OWNER_FALLBACK } from "../lib/copy";
import type { AgentClient, Shell } from "../lib/types";

/** "Stop protecting this computer": the owner is told, so ask first. */
export function StopView({ client, shell }: { client: AgentClient; shell: Shell }) {
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.status().then((s) => {
      if (s.ok) setOwner(s.ownerName);
    });
  }, [client]);

  async function stop() {
    setBusy(true);
    setError(null);
    const r = await client.unenroll();
    setBusy(false);
    if (r.ok) return void shell.close();
    setError(errorMessage(r.code, r.error));
  }

  const who = owner ?? OWNER_FALLBACK;
  return (
    <main className="page">
      <h1>Stop protecting this computer?</h1>
      <p>
        <strong>{who}</strong> will be told.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="button" className="danger" onClick={stop} disabled={busy}>
        Stop protecting
      </button>
      <button type="button" className="primary" onClick={() => void shell.close()} disabled={busy}>
        Keep protecting
      </button>
    </main>
  );
}
