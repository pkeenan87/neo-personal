import { useState } from "react";
import { errorMessage } from "../lib/copy";
import type { AgentClient, Confirm, Shell } from "../lib/types";

interface Props {
  confirm: Confirm;
  client: AgentClient;
  shell: Shell;
}

/**
 * "Your helper asked to end the remote session. End it now?": a plain, topmost window with two buttons.
 * Nothing is closed unless the person chooses "End the session"; closing the window, or doing nothing,
 * leaves the session as it is (the service declines after two minutes).
 */
export function ConfirmView({ confirm, client, shell }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(choice: "end" | "keep") {
    setBusy(true);
    setError(null);
    const r = await client.commandAnswer(confirm.id, choice);
    // `answered: false` means the question was already over (it timed out): nothing more to do here.
    if (r.ok) return void shell.close();
    setBusy(false);
    setError(errorMessage(r.code, r.error));
  }

  return (
    <main className="warning" role="alertdialog" aria-labelledby="confirm-headline">
      <h1 id="confirm-headline">{confirm.title}</h1>
      {confirm.body && <p>{confirm.body}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="button" className="danger big" onClick={() => void answer("end")} disabled={busy}>
        End the session
      </button>
      <button type="button" className="primary big" onClick={() => void answer("keep")} disabled={busy}>
        Keep it
      </button>
    </main>
  );
}
