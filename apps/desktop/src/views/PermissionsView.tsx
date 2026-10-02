import { useState } from "react";
import { FDA_GRANTED, FDA_NEVER_ON_A_CALL, FDA_NOT_YET, FDA_ONLY_SETTING, FDA_RESTARTING, FDA_TITLE, FDA_WHY, errorMessage } from "../lib/copy";
import type { AgentClient, Shell } from "../lib/types";

type Outcome = { name: "idle" } | { name: "checking" } | { name: "granted" } | { name: "restarting" } | { name: "not-yet" } | { name: "error"; message: string };

interface Props {
  client: AgentClient;
  shell: Shell;
  /** Called when the person presses "Skip for now" or closes the step after it succeeded. Defaults to closing the window. */
  onFinished?: () => void;
}

/**
 * macOS: the Full Disk Access step ("Let Neo check app permissions"). It explains why in plain
 * words, opens the System Settings pane, shows the daemon in Finder for the + button, and asks the
 * service to probe when the person presses Done. It is shown in the first-run window after enrollment
 * and again from the tray menu while the access is missing. "Skip for now" is always there.
 */
export function PermissionsView({ client, shell, onFinished }: Props) {
  const [outcome, setOutcome] = useState<Outcome>({ name: "idle" });
  const finish = onFinished ?? (() => void shell.close());

  async function openSettings() {
    try {
      await shell.openFullDiskAccess();
    } catch {
      setOutcome({ name: "error", message: "Couldn't open System Settings. Open it yourself, then Privacy & Security, then Full Disk Access." });
    }
  }

  async function showInFinder() {
    try {
      await shell.showDaemonInFinder();
    } catch {
      setOutcome({ name: "error", message: "Couldn't open Finder." });
    }
  }

  async function check() {
    setOutcome({ name: "checking" });
    const r = await client.probePermissions();
    if (!r.ok) {
      // The service restarts itself to see a new grant; for a moment it does not answer.
      return setOutcome(r.code === "agent_unavailable" ? { name: "restarting" } : { name: "error", message: errorMessage(r.code, r.error) });
    }
    if (r.fullDiskAccess) return setOutcome({ name: "granted" });
    setOutcome(r.restarting ? { name: "restarting" } : { name: "not-yet" });
  }

  if (outcome.name === "granted") {
    return (
      <main className="page">
        <h1>{FDA_TITLE}</h1>
        <p role="status">
          <strong>{FDA_GRANTED}</strong>
        </p>
        <button type="button" className="primary" onClick={finish}>
          Close
        </button>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>{FDA_TITLE}</h1>
      <p>{FDA_WHY}</p>
      <ol>
        <li>
          <button type="button" className="primary" onClick={openSettings}>
            Open System Settings
          </button>
        </li>
        <li>
          Turn on <strong>Neo Protection</strong>. If it is not in the list, press <strong>+</strong> and choose <strong>Neo Protection</strong>.{" "}
          <button type="button" className="link" onClick={showInFinder}>
            Show Neo Protection in Finder
          </button>
        </li>
        <li>Come back here and press Done.</li>
      </ol>
      <p>{FDA_ONLY_SETTING}</p>
      <p>{FDA_NEVER_ON_A_CALL}</p>
      {outcome.name === "restarting" && <p role="status">{FDA_RESTARTING}</p>}
      {outcome.name === "not-yet" && <p role="status">{FDA_NOT_YET}</p>}
      {outcome.name === "error" && (
        <p role="alert" className="error">
          {outcome.message}
        </p>
      )}
      <button type="button" className="primary" onClick={check} disabled={outcome.name === "checking"}>
        Done
      </button>
      <button type="button" onClick={finish} disabled={outcome.name === "checking"}>
        Skip for now
      </button>
    </main>
  );
}
