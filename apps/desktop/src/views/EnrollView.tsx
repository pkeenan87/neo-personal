import { useEffect, useRef, useState } from "react";
import { consentText, errorMessage, NEVER_SENT } from "../lib/copy";
import type { AgentClient, AgentStatus, EnrollPreview, Shell, SignInStart } from "../lib/types";

type Screen =
  | { name: "loading" }
  | { name: "choice" }
  | { name: "code" }
  | { name: "consent"; preview: EnrollPreview }
  | { name: "sign-in"; start: SignInStart }
  | { name: "done"; status: AgentStatus };

interface Props {
  client: AgentClient;
  shell: Shell;
}

/** First-run window: "I have a code from my family" (code, preview, consent, enroll) or "Sign in with my Neo account". */
export function EnrollView({ client, shell }: Props) {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    client.status().then((s) => {
      if (!alive) return;
      if (!s.ok) {
        setError(errorMessage(s.code, s.error));
        setScreen({ name: "choice" });
        return;
      }
      setStatus(s);
      setDeviceName(s.computerName);
      setServerUrl(s.serverUrl);
      setScreen(s.state === "enrolled" ? { name: "done", status: s } : { name: "choice" });
    });
    return () => {
      alive = false;
    };
  }, [client]);

  useEffect(() => () => clearTimeout(poll.current), []);

  // The advanced server address only matters when it differs from the default the service reports.
  const customServer = showAdvanced && serverUrl.trim() && serverUrl.trim() !== status?.serverUrl ? serverUrl.trim() : undefined;

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setError(null);
    setBusy(true);
    const r = await client.enrollPreview(code.trim(), customServer);
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.code, r.error));
    setScreen({ name: "consent", preview: r });
  }

  async function confirm() {
    setError(null);
    setBusy(true);
    const r = await client.enroll(code.trim(), deviceName.trim(), customServer);
    setBusy(false);
    if (!r.ok) {
      setError(errorMessage(r.code, r.error));
      return setScreen({ name: "code" });
    }
    setScreen({ name: "done", status: r });
  }

  function schedulePoll(seconds: number) {
    poll.current = setTimeout(async () => {
      const r = await client.selfEnrollPoll();
      if (!r.ok) {
        setError(errorMessage(r.code, r.error));
        return setScreen({ name: "choice" });
      }
      if (r.status === "pending") return schedulePoll(r.interval);
      if (r.status === "approved") {
        const s = await client.status();
        if (s.ok) return setScreen({ name: "done", status: s });
        return setScreen({ name: "choice" });
      }
      setError(r.status === "denied" ? "The sign-in was declined in the browser." : "The sign-in expired. Start again.");
      setScreen({ name: "choice" });
    }, seconds * 1000);
  }

  async function startSignIn() {
    setError(null);
    setBusy(true);
    const r = await client.selfEnrollStart(deviceName.trim(), customServer);
    setBusy(false);
    if (!r.ok) return setError(errorMessage(r.code, r.error));
    setScreen({ name: "sign-in", start: r });
    await shell.openUrl(r.verificationUriComplete);
    schedulePoll(r.interval);
  }

  function cancelSignIn() {
    clearTimeout(poll.current);
    setScreen({ name: "choice" });
  }

  return (
    <main className="page">
      <h1>Set up Neo</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {screen.name === "loading" && <p>Loading…</p>}

      {screen.name === "choice" && (
        <section>
          <p>Neo warns you about remote-access scams on this computer.</p>
          <button type="button" className="primary" onClick={() => setScreen({ name: "code" })}>
            I have a code from my family
          </button>
          <button type="button" onClick={startSignIn} disabled={busy}>
            Sign in with my Neo account
          </button>
          <p>
            <button type="button" className="link" onClick={() => setShowAdvanced((v) => !v)}>
              Advanced
            </button>
          </p>
          {showAdvanced && (
            <label>
              Server address (for self-hosted Neo)
              <input type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            </label>
          )}
        </section>
      )}

      {screen.name === "code" && (
        <form onSubmit={submitCode}>
          <label>
            Enter the code you were given
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="primary" disabled={busy || !code.trim()}>
            Continue
          </button>
          <button type="button" onClick={() => setScreen({ name: "choice" })}>
            Back
          </button>
        </form>
      )}

      {screen.name === "consent" && (
        <section>
          <ConsentCopy preview={screen.preview} />
          <label>
            Name for this computer
            <input type="text" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
          </label>
          <button type="button" className="primary" onClick={confirm} disabled={busy || !deviceName.trim()}>
            Turn on protection
          </button>
          <button type="button" onClick={() => setScreen({ name: "code" })}>
            Back
          </button>
        </section>
      )}

      {screen.name === "sign-in" && (
        <section>
          <p>
            A browser window opened so you can sign in to Neo. If it did not, go to <strong>{screen.start.verificationUri}</strong> and enter this code:
          </p>
          <p className="code">{screen.start.userCode}</p>
          <p>Waiting for you to finish…</p>
          <button type="button" onClick={cancelSignIn}>
            Cancel
          </button>
        </section>
      )}

      {screen.name === "done" && (
        <section>
          <p role="status">
            <strong>Neo is protecting this computer.</strong>
          </p>
          <p>
            Protecting <strong>{screen.status.memberName ?? "this computer"}</strong>&apos;s computer for <strong>{screen.status.householdName ?? "your household"}</strong>.
          </p>
          <button type="button" className="primary" onClick={() => void shell.close()}>
            Done
          </button>
        </section>
      )}
    </main>
  );
}

function ConsentCopy({ preview }: { preview: EnrollPreview }) {
  const { owner, household } = consentText(preview.ownerName, preview.householdName);
  return (
    <p>
      This computer will warn you about remote-access scams and tell <strong>{owner}</strong> (household <strong>{household}</strong>) when it finds one. {NEVER_SENT}
    </p>
  );
}
