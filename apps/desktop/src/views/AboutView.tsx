import type { Shell } from "../lib/types";

/** "About and privacy": what Neo watches and what it sends. Mirrors the privacy page. */
export function AboutView({ shell, version }: { shell: Shell; version?: string }) {
  return (
    <main className="page">
      <h1>About Neo</h1>
      {version && <p className="muted">Version {version}</p>}
      <p>
        Neo warns you about remote-access scams. It checks the programs and remote-access tools on this computer, and it sends Neo only the name of a remote-access tool or
        flagged program when one appears, a remote peer ID during an incoming session, and the fingerprint (SHA-256) of an unsigned new program so it can be checked.
      </p>
      <p>It never sends your list of programs, your files or your browsing.</p>
      <p>
        <button type="button" className="link" onClick={() => void shell.openUrl("https://www.neoshield.dev/privacy")}>
          Read the privacy page
        </button>
      </p>
      <button type="button" className="primary" onClick={() => void shell.close()}>
        Close
      </button>
    </main>
  );
}
