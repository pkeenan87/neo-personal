import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { getState } from "@/lib/state.js";
import { listsSnapshot } from "@/lib/listsSnapshot.js";
import { sendToBackground } from "@/lib/messages.js";
import { defangDomain } from "@/lib/format.js";
import type { WarningRecord } from "@/lib/types.js";

async function goToSafety(): Promise<void> {
  await browser.tabs.create({});
  try {
    const self = await browser.tabs.getCurrent();
    if (self?.id !== undefined) await browser.tabs.remove(self.id);
  } catch {
    /* best effort */
  }
}

export function App() {
  const [warning, setWarning] = useState<WarningRecord | null | undefined>(undefined);
  const [brandName, setBrandName] = useState<string | null>(null);
  const [brandDomain, setBrandDomain] = useState<string | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(location.search).get("e");
    void (async () => {
      const state = await getState();
      const found = state.warnings.find((w) => w.id === id) ?? null;
      setWarning(found);
      if (found?.brand) {
        const lists = state.lists ?? listsSnapshot;
        const brand = lists.brands.find((b) => b.id === found.brand);
        setBrandName(brand?.name ?? null);
        setBrandDomain(brand?.domains[0] ?? null);
      }
    })();
  }, []);

  async function goBackAnyway() {
    if (!warning) return;
    await sendToBackground({ type: "warning-bypassed", relatesTo: warning.id, domain: warning.domain, originalUrl: warning.originalUrl });
  }

  if (warning === undefined) return null;

  const isTechSupport = warning?.detector === "tech_support_scam";

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: 28 }}>
        {isTechSupport ? "This is a fake warning." : `This page is pretending to be ${brandName ?? "a well-known company"}.`}
      </h1>

      {isTechSupport ? (
        <p style={{ fontSize: 20 }}>
          Microsoft and Apple never show phone numbers on web pages. Your computer is fine. Don&apos;t call the number, and don&apos;t let anyone
          connect to your computer.
        </p>
      ) : (
        <p style={{ fontSize: 20 }}>
          Don&apos;t type your password here. Go to {brandDomain ? defangDomain(brandDomain) : "the official site"} yourself.
        </p>
      )}

      {warning && <p style={{ opacity: 0.85 }}>{defangDomain(warning.domain)}</p>}
      {warning?.ownerNotified && <p style={{ opacity: 0.85 }}>Neo let the household owner know.</p>}

      <button
        type="button"
        onClick={() => void goToSafety()}
        style={{ fontSize: 18, padding: "12px 24px", marginTop: 24, background: "#ffffff", color: "#7a1f1f", border: "none", borderRadius: 6 }}
      >
        Take me to safety
      </button>

      <p style={{ marginTop: 24 }}>
        <button
          type="button"
          onClick={() => void goBackAnyway()}
          style={{ background: "none", border: "none", color: "#ffffff", textDecoration: "underline", opacity: 0.8, cursor: "pointer" }}
        >
          Go back to the page anyway
        </button>
      </p>
    </main>
  );
}
