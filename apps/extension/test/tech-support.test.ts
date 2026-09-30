import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isTechSupportScamHit } from "@neo/verdict";
import { applyHookSignal, BehaviorTracker, evaluateTechSupport, scanPageText } from "../lib/detectors/techSupport.js";
import { listsSnapshot } from "../lib/listsSnapshot.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixtureText(name: string): string {
  const html = readFileSync(join(fixturesDir, name), "utf8");
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return body.textContent ?? "";
}

const phrases = listsSnapshot.scamPagePhrases;

describe("BehaviorTracker (indicator collectors)", () => {
  it("adds fullscreen/pointer_lock only when the state actually changes to true", () => {
    const tracker = new BehaviorTracker();
    tracker.onFullscreenChange(false);
    tracker.onPointerLockChange(false);
    expect(tracker.snapshot().size).toBe(0);
    tracker.onFullscreenChange(true);
    tracker.onPointerLockChange(true);
    expect(tracker.snapshot()).toEqual(new Set(["fullscreen", "pointer_lock"]));
  });

  it("flags back_trap at 3+ history mutations within 5s, not before", () => {
    let now = 0;
    const tracker = new BehaviorTracker({ now: () => now });
    tracker.onHistoryMutation();
    tracker.onHistoryMutation();
    expect(tracker.snapshot().has("back_trap")).toBe(false);
    now += 1000;
    tracker.onHistoryMutation();
    expect(tracker.snapshot().has("back_trap")).toBe(true);
  });

  it("does not carry a history-mutation streak across a >5s gap", () => {
    let now = 0;
    const tracker = new BehaviorTracker({ now: () => now });
    tracker.onHistoryMutation();
    tracker.onHistoryMutation();
    now += 6000;
    tracker.onHistoryMutation(); // starts a new window: only 1 in the new window
    expect(tracker.snapshot().has("back_trap")).toBe(false);
  });

  it("flags looping_audio at 3+ restarts of the same element, not a different element each time", () => {
    const tracker = new BehaviorTracker();
    tracker.onMediaRestart("video-a");
    tracker.onMediaRestart("video-a");
    expect(tracker.snapshot().has("looping_audio")).toBe(false);
    tracker.onMediaRestart("video-a");
    expect(tracker.snapshot().has("looping_audio")).toBe(true);
  });

  it("onMediaLoop and onUnloadTrap and onKeyboardLock are direct, one-shot signals", () => {
    const tracker = new BehaviorTracker();
    tracker.onMediaLoop();
    tracker.onUnloadTrap();
    tracker.onKeyboardLock();
    expect(tracker.snapshot()).toEqual(new Set(["looping_audio", "unload_trap", "keyboard_lock"]));
  });
});

describe("applyHookSignal (forged CustomEvent cannot change the reported domain)", () => {
  it("only reads `kind`; it has no domain parameter to forge in the first place", () => {
    const tracker = new BehaviorTracker();
    // A forged event might carry an extra `domain` field, but `applyHookSignal`'s signature
    // cannot accept it — there is no code path from an event's contents to a reported domain.
    const forged = { kind: "keyboard_lock", domain: "attacker.example" } as const;
    applyHookSignal(forged.kind, tracker);
    expect(tracker.snapshot().has("keyboard_lock")).toBe(true);
  });

  it("ignores an unrecognized kind instead of throwing", () => {
    const tracker = new BehaviorTracker();
    // @ts-expect-error -- deliberately an invalid/forged kind
    applyHookSignal("not_a_real_kind", tracker);
    expect(tracker.snapshot().size).toBe(0);
  });

});

describe("scanPageText", () => {
  it("requires both a support phrase and a phone number for support_phone_text", () => {
    const withPhone = scanPageText("call microsoft support now at 1-855-555-0199", phrases, "en-US");
    expect(withPhone.indicators.has("support_phone_text")).toBe(true);
    expect(withPhone.phone).toBeTruthy();

    const withoutPhone = scanPageText("call microsoft support now", phrases, "en-US");
    expect(withoutPhone.indicators.has("support_phone_text")).toBe(false);
  });
});

describe("isTechSupportScamHit on the fixtures", () => {
  it("the fake support page (text, number, fullscreen) is a hit", () => {
    const text = fixtureText("support-page.html");
    const scan = scanPageText(text, phrases, "en-US");
    const tracker = new BehaviorTracker();
    tracker.onFullscreenChange(true);
    tracker.onHistoryMutation();
    tracker.onHistoryMutation();
    tracker.onHistoryMutation();
    tracker.onUnloadTrap();

    const evaluation = evaluateTechSupport(tracker.snapshot(), scan);
    expect(evaluation.hit).toBe(true);
    expect(isTechSupportScamHit(evaluation.indicators)).toBe(true);
    expect(evaluation.phone).toBeTruthy();
  });

  it("the game page (fullscreen + pointer lock only, no scam text) is not a hit", () => {
    const text = fixtureText("game-page.html");
    const scan = scanPageText(text, phrases, "en-US");
    expect(scan.indicators.size).toBe(0);

    const tracker = new BehaviorTracker();
    tracker.onFullscreenChange(true);
    tracker.onPointerLockChange(true);

    const evaluation = evaluateTechSupport(tracker.snapshot(), scan);
    expect(evaluation.hit).toBe(false);
  });

  it("the real support article (one text indicator, no behaviour) is not a hit", () => {
    const text = fixtureText("support-article.html");
    const scan = scanPageText(text, phrases, "en-US");
    expect(scan.indicators.has("support_phone_text")).toBe(true);

    const tracker = new BehaviorTracker(); // no page behaviour at all
    const evaluation = evaluateTechSupport(tracker.snapshot(), scan);
    expect(evaluation.hit).toBe(false);
  });
});
