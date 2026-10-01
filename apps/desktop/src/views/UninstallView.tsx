import { useEffect, useState } from "react";
import { uninstallConfirm } from "../lib/copy";
import type { AgentClient, Shell } from "../lib/types";

/**
 * macOS "Uninstall Neo...": asks first, names who will be told, and only then runs the uninstall
 * (which asks for an administrator password). Moving Neo to the Trash is also an uninstall, and the
 * owner is told then too; this is the tidy way.
 */
export function UninstallView({ client, shell }: { client: AgentClient; shell: Shell }) {
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.status().then((s) => {
      if (s.ok) setOwner(s.ownerName);
    });
  }, [client]);

  async function uninstall() {
    setBusy(true);
    setError(null);
    try {
      await shell.uninstallMac();
      // The uninstall removes Neo, this window included; if we are still here, close it.
      await shell.close();
    } catch {
      setBusy(false);
      setError("Neo was not uninstalled. If you cancelled the password window, nothing was changed.");
    }
  }

  const c = uninstallConfirm(owner);
  return (
    <main className="page">
      <h1>{c.headline}</h1>
      <p>
        <strong>{c.who}</strong> will be told.
      </p>
      <p>{c.rest}</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="button" className="danger" onClick={uninstall} disabled={busy}>
        Uninstall
      </button>
      <button type="button" className="primary" onClick={() => void shell.close()} disabled={busy}>
        Keep Neo
      </button>
    </main>
  );
}
