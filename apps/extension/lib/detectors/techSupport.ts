/**
 * Tech-support-scam page detector (`_specs/browser-extension.md` "Detectors" /
 * `_specs/signals.md` Events table). Pure, DOM-agnostic pieces so they are unit-testable without
 * a real browser; `entrypoints/content-detect.ts` wires this to the isolated-world content
 * script's own DOM events and to the `CustomEvent`s the MAIN-world hook script dispatches.
 *
 * The domain reported in an event is never taken from anything a page (or a forged `CustomEvent`)
 * supplies: `entrypoints/content-detect.ts` always reads it from the isolated script's own
 * `location`, and the pure functions here never accept a domain at all.
 */
import { extractPhoneNumbers, normalizeForMatch } from "@neo/tools/browser";
import type { DetectionListsPayload } from "@neo/tools/browser";
import { TECH_SUPPORT_INDICATORS, isTechSupportScamHit, type TechSupportIndicator } from "@neo/verdict";
import type { HookSignalKind } from "./hookProtocol.js";

export type ScamPagePhrase = DetectionListsPayload["scamPagePhrases"][number];

/** `_specs/browser-extension.md`: "the first 100,000 characters". */
export const MAX_TEXT_CHARS = 100_000;

/** The `TECH_SUPPORT_INDICATORS` set from page *behaviour*, as opposed to page text. */
export type BehaviorIndicator = Exclude<TechSupportIndicator, "support_phone_text" | "fake_scan">;

export const BEHAVIOR_INDICATORS = TECH_SUPPORT_INDICATORS.filter(
  (i): i is BehaviorIndicator => i !== "support_phone_text" && i !== "fake_scan",
);

export interface TextScanResult {
  indicators: Set<Extract<TechSupportIndicator, "support_phone_text" | "fake_scan">>;
  phone?: string;
}

/** A BCP-47 language tag (`navigator.language`) narrowed to a 2-letter region for phone parsing. */
function regionFromLanguage(lang: string | undefined): string | undefined {
  const region = lang?.split(/[-_]/)[1];
  return region && region.length === 2 ? region.toUpperCase() : undefined;
}

/**
 * Scans already-collected page text for `support_phone_text` (a support phrase *and* a phone
 * number) and `fake_scan` (a fake-scan phrase alone). `rawText` should already be at most
 * `MAX_TEXT_CHARS`; this also defensively truncates.
 */
export function scanPageText(rawText: string, phrases: readonly ScamPagePhrase[], userLanguage?: string): TextScanResult {
  const text = normalizeForMatch(rawText.slice(0, MAX_TEXT_CHARS));
  const indicators: TextScanResult["indicators"] = new Set();

  const hasSupportPhrase = phrases.some((p) => p.kind === "support_phone_text" && text.includes(p.phrase));
  const hasFakeScanPhrase = phrases.some((p) => p.kind === "fake_scan" && text.includes(p.phrase));

  let phone: string | undefined;
  if (hasSupportPhrase) {
    const phones = extractPhoneNumbers(text, { userCountry: regionFromLanguage(userLanguage) });
    if (phones.length > 0) {
      indicators.add("support_phone_text");
      phone = phones[0];
    }
  }
  if (hasFakeScanPhrase) indicators.add("fake_scan");

  return { indicators, phone };
}

/**
 * Tracks the behaviour indicators over a page's lifetime. Every `on*` method is a pure state
 * transition driven by the caller (real DOM events in production, synthetic calls in tests) — it
 * never reads `document`/`window` itself.
 */
export class BehaviorTracker {
  private indicators = new Set<BehaviorIndicator>();
  private historyPushCount = 0;
  private historyWindowStartedAt: number | null = null;
  private mediaRestarts = new Map<unknown, number>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  snapshot(): Set<BehaviorIndicator> {
    return new Set(this.indicators);
  }

  onFullscreenChange(isFullscreen: boolean): void {
    if (isFullscreen) this.indicators.add("fullscreen");
  }

  onPointerLockChange(isLocked: boolean): void {
    if (isLocked) this.indicators.add("pointer_lock");
  }

  onKeyboardLock(): void {
    this.indicators.add("keyboard_lock");
  }

  /** A `history.pushState`/`replaceState` call. 3+ within 5s of the first one is a hit. */
  onHistoryMutation(): void {
    const t = this.now();
    if (this.historyWindowStartedAt === null || t - this.historyWindowStartedAt > 5000) {
      this.historyWindowStartedAt = t;
      this.historyPushCount = 0;
    }
    this.historyPushCount += 1;
    if (this.historyPushCount >= 3) this.indicators.add("back_trap");
  }

  /** A `popstate` handler that immediately pushes again (a back-button trap). */
  onPopstateRepush(): void {
    this.indicators.add("back_trap");
  }

  /** A `beforeunload` handler that calls `preventDefault()` or sets `returnValue`. */
  onUnloadTrap(): void {
    this.indicators.add("unload_trap");
  }

  /** A media element with the `loop` attribute playing. */
  onMediaLoop(): void {
    this.indicators.add("looping_audio");
  }

  /** A media element that restarted itself (no `loop` attribute) — 3+ restarts is a hit. */
  onMediaRestart(mediaKey: unknown): void {
    const n = (this.mediaRestarts.get(mediaKey) ?? 0) + 1;
    this.mediaRestarts.set(mediaKey, n);
    if (n >= 3) this.indicators.add("looping_audio");
  }
}

/**
 * Applies one hook-reported signal `kind` to a tracker. Deliberately takes only a `kind` — never
 * a whole event object — so a page (or a forged `neo:signal` `CustomEvent`) has no field it could
 * set to change what domain a hit is eventually reported for; that always comes from the isolated
 * script's own `location`, in a completely separate code path (`entrypoints/detect.content.ts`).
 * An unrecognized `kind` (forged or from a future hook version) is ignored.
 */
export function applyHookSignal(kind: HookSignalKind | undefined, tracker: BehaviorTracker): void {
  switch (kind) {
    case "history_mutation":
      tracker.onHistoryMutation();
      return;
    case "keyboard_lock":
      tracker.onKeyboardLock();
      return;
    case "unload_trap":
      tracker.onUnloadTrap();
      return;
    case "media_loop":
    case "media_restart":
      // Both mean the same indicator; the hook already applies the "3+ restarts" threshold per
      // element (it has element identity, which does not cross the world boundary).
      tracker.onMediaLoop();
      return;
    default:
      return;
  }
}

export interface TechSupportEvaluation {
  indicators: TechSupportIndicator[];
  phone?: string;
  hit: boolean;
}

/** Combines behaviour and text indicators and applies `isTechSupportScamHit`. */
export function evaluateTechSupport(behavior: Set<BehaviorIndicator>, text: TextScanResult): TechSupportEvaluation {
  const indicators = [...behavior, ...text.indicators];
  return { indicators, phone: text.phone, hit: isTechSupportScamHit(indicators) };
}
