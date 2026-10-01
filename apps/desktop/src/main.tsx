import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createTauriClient, loadWarning, onWarningUpdate, tauriShell } from "./lib/ipc";
import type { Warning } from "./lib/types";
import { AboutView } from "./views/AboutView";
import { CheckLinkView } from "./views/CheckLinkView";
import { EnrollView } from "./views/EnrollView";
import { StopView } from "./views/StopView";
import { WarningView } from "./views/WarningView";
import "./styles.css";

const client = createTauriClient();
const params = new URLSearchParams(window.location.search);

/** Loads the warning this window was opened for and follows updates to it. */
function WarningWindow({ eventId }: { eventId: string }) {
  const [warning, setWarning] = useState<Warning | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    void loadWarning(eventId).then(setWarning);
    void onWarningUpdate(eventId, setWarning).then((fn) => (off = fn));
    return () => off?.();
  }, [eventId]);
  return warning ? <WarningView warning={warning} shell={tauriShell} /> : null;
}

function App() {
  switch (params.get("view")) {
    case "warning":
      return <WarningWindow eventId={params.get("event") ?? ""} />;
    case "check":
      return <CheckLinkView client={client} />;
    case "stop":
      return <StopView client={client} shell={tauriShell} />;
    case "about":
      return <AboutView shell={tauriShell} />;
    default:
      return <EnrollView client={client} shell={tauriShell} />;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
