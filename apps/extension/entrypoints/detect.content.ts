import { defineContentScript } from "wxt/utils/define-content-script";
import { registrableDomain } from "@neo/tools/browser";
import { applyHookSignal, BehaviorTracker, evaluateTechSupport, scanPageText } from "@/lib/detectors/techSupport.js";
import { evaluateLookalike, isSendableLookalikeHit } from "@/lib/detectors/lookalike.js";
import { NEO_SIGNAL_EVENT, type HookSignalDetail } from "@/lib/detectors/hookProtocol.js";
import { getState } from "@/lib/state.js";
import { listsSnapshot } from "@/lib/listsSnapshot.js";
import { sendToBackground } from "@/lib/messages.js";

/** `_specs/browser-extension.md`: text scanning runs "for the first 60 seconds of the page only". */
const TEXT_SCAN_WINDOW_MS = 60_000;
const TEXT_SCAN_DEBOUNCE_MS = 1_000;

function pageText(): string {
  const body = document.body;
  if (!body) return "";
  // `innerText` reflects rendered/visible text; jsdom (tests) doesn't implement it, so fall back
  // to `textContent`, which is close enough for the fixtures.
  return body.innerText || body.textContent || "";
}

export default defineContentScript({
  matches: ["<all_urls>"],
  world: "ISOLATED",
  runAt: "document_start",
  allFrames: false,
  async main() {
    // No recognizable registrable domain (e.g. `localhost`, an unusual internal page): nothing to
    // report, and no domain we could trust to send anyway.
    const domainInfo = registrableDomain(location.hostname);
    if (!domainInfo) return;
    const domain = domainInfo.registrable;

    const state = await getState();
    const lists = state.lists ?? listsSnapshot;

    const tracker = new BehaviorTracker();
    const pageLoadedAt = Date.now();
    let techSupportReported = false;
    let lookalikeReported = false;

    function evaluateAndMaybeReportTechSupport(): void {
      if (techSupportReported) return;
      const scan = scanPageText(pageText(), lists.scamPagePhrases, navigator.language);
      const evaluation = evaluateTechSupport(tracker.snapshot(), scan);
      if (!evaluation.hit) return;
      techSupportReported = true;
      void sendToBackground({ type: "tech-support-hit", domain, pageUrl: location.href, indicators: evaluation.indicators, phone: evaluation.phone });
    }

    function evaluateAndMaybeReportLookalike(): void {
      if (lookalikeReported) return;
      if (!document.querySelector("input[type=password]")) return;
      const evaluation = evaluateLookalike(location.hostname, lists.brands, lists.skipDomains);
      if (!evaluation || !isSendableLookalikeHit(evaluation)) return;
      lookalikeReported = true;
      void sendToBackground({ type: "lookalike-hit", domain: evaluation.domain, pageUrl: location.href, brand: evaluation.brand, indicators: evaluation.indicators });
    }

    document.addEventListener(NEO_SIGNAL_EVENT, (event) => {
      // `applyHookSignal` only ever reads `.kind`: even a forged event with an extra `domain`
      // field (or any other field) cannot change what domain a later hit is reported for — that
      // always comes from this script's own `location` (`domain`, captured above).
      applyHookSignal((event as CustomEvent<HookSignalDetail>).detail?.kind, tracker);
      evaluateAndMaybeReportTechSupport();
    });

    document.addEventListener("fullscreenchange", () => {
      tracker.onFullscreenChange(!!document.fullscreenElement);
      evaluateAndMaybeReportTechSupport();
    });
    document.addEventListener("pointerlockchange", () => {
      tracker.onPointerLockChange(!!document.pointerLockElement);
      evaluateAndMaybeReportTechSupport();
    });

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleTextScan(): void {
      if (Date.now() - pageLoadedAt > TEXT_SCAN_WINDOW_MS) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(evaluateAndMaybeReportTechSupport, TEXT_SCAN_DEBOUNCE_MS);
    }

    if (document.readyState === "complete") evaluateAndMaybeReportTechSupport();
    else window.addEventListener("load", evaluateAndMaybeReportTechSupport, { once: true });

    evaluateAndMaybeReportLookalike();

    new MutationObserver(() => {
      scheduleTextScan();
      evaluateAndMaybeReportLookalike();
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  },
});
