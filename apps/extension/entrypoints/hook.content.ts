import { defineContentScript } from "wxt/utils/define-content-script";
import { NEO_SIGNAL_EVENT, type HookSignalKind } from "@/lib/detectors/hookProtocol.js";

/**
 * MAIN-world hook (`_specs/browser-extension.md` "Detectors", `tech_support_scam`). Wraps a
 * handful of page APIs that a tech-support-scam page abuses, and reports each use through a
 * `CustomEvent` on `document`. Every wrapper calls straight through afterwards, so the page
 * behaves exactly as it would without Neo installed.
 *
 * This script runs in the page's own JS realm (`world: "MAIN"`), so it can never read the
 * extension's storage or token, and the isolated-world script (`entrypoints/detect.content.ts`)
 * never trusts anything in the event's `detail` beyond "this kind of call happened" — the domain
 * it reports is always the isolated script's own `location`, never anything from this file or a
 * page that forges the same event.
 */
function dispatch(kind: HookSignalKind): void {
  try {
    document.dispatchEvent(new CustomEvent(NEO_SIGNAL_EVENT, { detail: { kind } }));
  } catch {
    /* document not ready, or CustomEvent unavailable in an unusual frame; never break the page */
  }
}

function hookHistory(): void {
  const target = window.history;
  const originalPush = target.pushState.bind(target);
  target.pushState = function patched(data: unknown, unused: string, url?: string | URL | null) {
    dispatch("history_mutation");
    return originalPush(data, unused, url);
  };
  const originalReplace = target.replaceState.bind(target);
  target.replaceState = function patched(data: unknown, unused: string, url?: string | URL | null) {
    dispatch("history_mutation");
    return originalReplace(data, unused, url);
  };
}

function hookKeyboardLock(): void {
  const keyboard = (navigator as Navigator & { keyboard?: { lock?: (...a: unknown[]) => unknown } }).keyboard;
  if (!keyboard || typeof keyboard.lock !== "function") return; // Chrome only
  const original = keyboard.lock.bind(keyboard);
  keyboard.lock = (...args: unknown[]) => {
    dispatch("keyboard_lock");
    return original(...args);
  };
}

/**
 * Detects a `beforeunload` handler that asks the browser to hold the user on the page. Nothing
 * the page registers is wrapped (so `removeEventListener` and `onbeforeunload = null` keep
 * working): the hook observes `preventDefault()` and `returnValue` writes on the event itself,
 * plus a string returned from an `onbeforeunload` handler. Fullscreen and pointer lock are not
 * hooked at all; the isolated script sees them through `fullscreenchange`/`pointerlockchange`.
 */
function hookBeforeUnload(): void {
  if (typeof BeforeUnloadEvent === "undefined") return;
  const proto = BeforeUnloadEvent.prototype;
  const preventDefault = Event.prototype.preventDefault;
  Object.defineProperty(proto, "preventDefault", {
    configurable: true,
    writable: true,
    value: function patched(this: Event) {
      dispatch("unload_trap");
      return preventDefault.call(this);
    },
  });

  const returnValue = Object.getOwnPropertyDescriptor(proto, "returnValue");
  if (returnValue?.get && returnValue.set) {
    const { get, set } = returnValue;
    Object.defineProperty(proto, "returnValue", {
      configurable: true,
      enumerable: returnValue.enumerable,
      get,
      set(this: BeforeUnloadEvent, value: unknown) {
        if (value !== "" && value !== false && value != null) dispatch("unload_trap");
        set.call(this, value);
      },
    });
  }

  const handlerProp = Object.getOwnPropertyDescriptor(window, "onbeforeunload") ?? Object.getOwnPropertyDescriptor(Window.prototype, "onbeforeunload");
  if (handlerProp?.get && handlerProp.set) {
    const nativeSet = handlerProp.set;
    let current: unknown = null;
    Object.defineProperty(window, "onbeforeunload", {
      configurable: true,
      enumerable: handlerProp.enumerable,
      get: () => current,
      set(handler: unknown) {
        current = typeof handler === "function" ? handler : null;
        if (typeof handler !== "function") return nativeSet.call(window, null);
        nativeSet.call(window, function (this: Window, event: BeforeUnloadEvent) {
          const result: unknown = (handler as (e: BeforeUnloadEvent) => unknown).call(this, event);
          if (typeof result === "string") dispatch("unload_trap");
          return result;
        });
      },
    });
  }
}

/** Reports a media element playing with `loop`, or restarting itself 3+ times without `loop`. */
function watchMedia(el: HTMLMediaElement): void {
  if ((el as HTMLMediaElement & { __neoWatched?: boolean }).__neoWatched) return;
  (el as HTMLMediaElement & { __neoWatched?: boolean }).__neoWatched = true;
  let plays = 0;
  el.addEventListener("play", () => {
    if (el.loop) {
      dispatch("media_loop");
      return;
    }
    plays += 1;
    if (plays >= 3) dispatch("media_restart");
  });
}

function hookMedia(): void {
  const scan = (root: ParentNode) => {
    root.querySelectorAll<HTMLMediaElement>("audio,video").forEach(watchMedia);
  };
  scan(document);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLMediaElement) watchMedia(node);
        else if (node instanceof Element) scan(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  runAt: "document_start",
  allFrames: false,
  main() {
    hookHistory();
    hookKeyboardLock();
    hookBeforeUnload();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hookMedia, { once: true });
    else hookMedia();
  },
});
