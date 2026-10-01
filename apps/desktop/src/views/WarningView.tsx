import { OWNER_FALLBACK, SESSION_ADVICE, sessionHeadline, toolToast, unwantedToast } from "../lib/copy";
import type { Shell, Warning } from "../lib/types";

interface Props {
  warning: Warning;
  shell: Shell;
}

/** The critical window: plain, in large type, with one button. It takes no action on the session. */
export function WarningView({ warning, shell }: Props) {
  const owner = warning.ownerName || OWNER_FALLBACK;
  return (
    <main className="warning" role="alertdialog" aria-labelledby="warning-headline">
      {warning.kind === "session" ? (
        <>
          <h1 id="warning-headline">{sessionHeadline(warning)}</h1>
          <p>{SESSION_ADVICE}</p>
        </>
      ) : (
        <h1 id="warning-headline">{warning.kind === "tool" ? toolToast(warning.toolName) : unwantedToast(warning.toolName)}</h1>
      )}
      {warning.ownerTold && <p>Neo let {owner} know.</p>}
      <button type="button" className="primary big" onClick={() => void shell.close()}>
        I understand
      </button>
    </main>
  );
}
