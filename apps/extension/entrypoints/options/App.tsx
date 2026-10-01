import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { sendToBackground } from "@/lib/messages.js";
import type { ApiResult, DeviceAuthStartResponse, EnrollDeviceResponse, EnrollmentPreviewResponse } from "@/lib/api.js";
import type { SignInPollResult } from "@/lib/sync.js";
import type { ExtensionState } from "@/lib/types.js";
import { defaultDeviceName, detectPlatform } from "@/lib/platform.js";

type Screen = "choice" | "code-entry" | "code-consent" | "sign-in" | "enrolled" | "disconnected";

function formatLastSeen(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString();
}

export function App() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName(detectPlatform()));
  const [preview, setPreview] = useState<EnrollmentPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrlInput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [hostAccess, setHostAccess] = useState<boolean | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function refresh() {
    const s = await sendToBackground<ExtensionState>({ type: "get-state" });
    setState(s);
    return s;
  }

  useEffect(() => {
    sendToBackground<ExtensionState>({ type: "get-state" }).then(setState).catch(() => {});
    browser.permissions
      .contains({ origins: ["<all_urls>"] })
      .then(setHostAccess)
      .catch(() => setHostAccess(null));
  }, []);

  useEffect(() => {
    if (state?.connection !== "enrolling") {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      return;
    }
    const interval = (state.signIn?.interval ?? 5) * 1000;
    async function tick() {
      const result = await sendToBackground<SignInPollResult>({ type: "poll-sign-in" });
      const next = await refresh();
      if (result === "pending" && next.connection === "enrolling") {
        pollTimer.current = setTimeout(tick, interval);
      }
    }
    pollTimer.current = setTimeout(tick, interval);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.connection, state?.signIn?.deviceCode]);

  async function requestHostAccess() {
    const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
    setHostAccess(granted);
  }

  async function submitAdvancedServer() {
    if (!serverUrl.trim()) return;
    const result = await sendToBackground<{ ok: boolean; error?: string }>({ type: "set-server-url", url: serverUrl.trim() });
    if (!result.ok) setError(result.error === "invalid_url" ? "That doesn't look like a valid server address." : "Already enrolled.");
    else setShowAdvanced(false);
  }

  async function previewCode() {
    setError(null);
    setBusy(true);
    const result = await sendToBackground<ApiResult<EnrollmentPreviewResponse>>({ type: "preview-code", code });
    setBusy(false);
    if (!result.ok) {
      setError(result.status === 404 ? "That code isn't valid, or it has expired." : "Couldn't reach Neo. Check your connection and try again.");
      return;
    }
    setPreview(result.data);
  }

  async function confirmEnroll() {
    setBusy(true);
    const result = await sendToBackground<ApiResult<EnrollDeviceResponse>>({ type: "enroll-with-code", code, deviceName });
    setBusy(false);
    if (!result.ok) {
      setError("Couldn't turn on protection. The code may have expired — try again.");
      setPreview(null);
      return;
    }
    await refresh();
  }

  async function startSignIn() {
    setError(null);
    setBusy(true);
    const result = await sendToBackground<ApiResult<DeviceAuthStartResponse>>({ type: "start-sign-in", deviceName });
    setBusy(false);
    if (!result.ok) {
      setError("Couldn't reach Neo. Check your connection and try again.");
      return;
    }
    window.open(result.data.verificationUriComplete, "_blank", "noopener,noreferrer");
    await refresh();
  }

  async function cancelSignIn() {
    await sendToBackground({ type: "cancel-sign-in" });
    await refresh();
  }

  async function stopProtecting() {
    const isOwnDevice = state?.household?.memberName == null;
    const warning = isOwnDevice
      ? "Stop protecting this browser?"
      : `Stop protecting this browser? ${state?.household?.ownerName ?? "The household owner"} will be told.`;
    if (!window.confirm(warning)) return;
    await sendToBackground({ type: "stop-protecting" });
    await refresh();
  }

  if (!state) return <main style={{ padding: 24 }}>Loading…</main>;

  const screen: Screen =
    state.connection === "enrolled"
      ? "enrolled"
      : state.connection === "enrolling"
        ? "sign-in"
        : preview
          ? "code-consent"
          : code.length > 0
            ? "code-entry"
            : "choice";

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 20 }}>Neo</h1>

      {state.connection === "disconnected" && (
        <p style={{ background: "#fdecea", color: "#c0392b", padding: 10, borderRadius: 6 }}>
          This browser is no longer connected to a household. Set it up again below.
        </p>
      )}

      {hostAccess === false && (
        <p style={{ background: "#fff4e5", color: "#8a5b00", padding: 10, borderRadius: 6 }}>
          Neo can&apos;t check pages. Allow access to all sites.{" "}
          <button type="button" onClick={requestHostAccess}>
            Allow
          </button>
        </p>
      )}

      {screen === "enrolled" && (
        <section>
          <p>
            Protecting <strong>{state.household?.memberName ?? "this browser"}</strong>&apos;s browser for{" "}
            <strong>{state.household?.householdName}</strong>.
          </p>
          <p style={{ color: "#4a5361" }}>Last check-in: {formatLastSeen(state.lastHeartbeatAt)}.</p>
          <h2 style={{ fontSize: 15 }}>What Neo watches for</h2>
          <ul>
            <li>Fake tech-support pages (phone-scam warning signs)</li>
            <li>Login pages pretending to be a well-known brand</li>
            <li>Remote-access software installed from an unexpected site</li>
          </ul>
          <h2 style={{ fontSize: 15 }}>What Neo never sends</h2>
          <p style={{ color: "#4a5361" }}>Your browsing history, page content, form contents or passwords.</p>
          <p style={{ background: "#eef6ff", padding: 10, borderRadius: 6 }}>
            Pin Neo&apos;s icon in your toolbar so you can always see it&apos;s watching.
          </p>
          <button type="button" onClick={stopProtecting} style={{ color: "#c0392b" }}>
            Stop protecting this browser
          </button>
        </section>
      )}

      {screen === "sign-in" && state.signIn && (
        <section>
          <p>Finish signing in at the tab that just opened.</p>
          <p>
            Verification code: <strong>{state.signIn.userCode}</strong>
          </p>
          <p>
            <a href={state.signIn.verificationUri} target="_blank" rel="noreferrer">
              Open sign-in page again
            </a>
          </p>
          <button type="button" onClick={cancelSignIn}>
            Cancel
          </button>
        </section>
      )}

      {screen === "code-consent" && preview && (
        <section>
          <p>
            This browser will warn you about scam pages and tell <strong>{preview.ownerName ?? "the household owner"}</strong> (household{" "}
            <strong>{preview.householdName}</strong>) when it finds one. It never sends your browsing history.
          </p>
          <label>
            Device name
            <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} style={{ display: "block", width: "100%", padding: 8 }} />
          </label>
          <button type="button" onClick={confirmEnroll} disabled={busy} style={{ marginTop: 12 }}>
            Turn on protection
          </button>
          <button type="button" onClick={() => setPreview(null)} style={{ marginLeft: 8 }}>
            Back
          </button>
        </section>
      )}

      {(screen === "choice" || screen === "code-entry") && (
        <section>
          <h2 style={{ fontSize: 15 }}>I have a code from my family</h2>
          <input
            placeholder="Enrollment code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ display: "block", width: "100%", padding: 8, marginBottom: 8 }}
          />
          <button type="button" onClick={previewCode} disabled={busy || code.trim().length === 0}>
            Continue
          </button>

          <h2 style={{ fontSize: 15, marginTop: 24 }}>Sign in with my Neo account</h2>
          <button type="button" onClick={startSignIn} disabled={busy}>
            Sign in
          </button>

          {error && <p style={{ color: "#c0392b" }}>{error}</p>}

          <p style={{ marginTop: 24 }}>
            <button type="button" onClick={() => setShowAdvanced((v) => !v)} style={{ background: "none", border: "none", color: "#4a5361", padding: 0 }}>
              Advanced: server
            </button>
          </p>
          {showAdvanced && (
            <div>
              <input
                placeholder="https://your-server.example"
                value={serverUrl}
                onChange={(e) => setServerUrlInput(e.target.value)}
                style={{ display: "block", width: "100%", padding: 8, marginBottom: 8 }}
              />
              <button type="button" onClick={submitAdvancedServer}>
                Save
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
