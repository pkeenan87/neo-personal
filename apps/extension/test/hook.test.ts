import { beforeAll, describe, expect, it } from "vitest";
import hook from "../entrypoints/hook.content.js";
import { NEO_SIGNAL_EVENT, type HookSignalKind } from "../lib/detectors/hookProtocol.js";

// The MAIN-world hook must never change how a page behaves (`_specs/browser-extension.md`).
const originalRequestFullscreen = Element.prototype.requestFullscreen;
const seen: HookSignalKind[] = [];

beforeAll(() => {
  document.addEventListener(NEO_SIGNAL_EVENT, (e) => seen.push((e as CustomEvent<{ kind: HookSignalKind }>).detail.kind));
  (hook as unknown as { main: () => void }).main();
});

function fireBeforeUnload(): BeforeUnloadEvent {
  const event = document.createEvent("BeforeUnloadEvent") as BeforeUnloadEvent;
  event.initEvent("beforeunload", false, true);
  window.dispatchEvent(event);
  return event;
}

describe("MAIN-world hook", () => {
  it("leaves requestFullscreen untouched", () => {
    expect(Element.prototype.requestFullscreen).toBe(originalRequestFullscreen);
  });

  it("reports a beforeunload handler that calls preventDefault, and the event is still cancelled", () => {
    seen.length = 0;
    const trap = (e: Event) => e.preventDefault();
    window.addEventListener("beforeunload", trap);
    const event = fireBeforeUnload();
    window.removeEventListener("beforeunload", trap);
    expect(seen).toContain("unload_trap");
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not report a handler that does nothing", () => {
    seen.length = 0;
    const noop = () => undefined;
    window.addEventListener("beforeunload", noop);
    fireBeforeUnload();
    window.removeEventListener("beforeunload", noop);
    expect(seen).not.toContain("unload_trap");
  });

  it("lets the page remove its own handlers", () => {
    seen.length = 0;
    const trap = (e: Event) => e.preventDefault();
    window.addEventListener("beforeunload", trap);
    window.removeEventListener("beforeunload", trap);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
    expect(seen).not.toContain("unload_trap");
  });

  it("keeps onbeforeunload readable and clearable", () => {
    seen.length = 0;
    const handler = () => "Are you sure?";
    window.onbeforeunload = handler;
    expect(window.onbeforeunload).toBe(handler);
    fireBeforeUnload();
    expect(seen).toContain("unload_trap");
    seen.length = 0;
    window.onbeforeunload = null;
    expect(window.onbeforeunload).toBeNull();
    fireBeforeUnload();
    expect(seen).not.toContain("unload_trap");
  });
});
