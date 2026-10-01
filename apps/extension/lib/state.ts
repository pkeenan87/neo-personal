import { browser } from "wxt/browser";
import { DEFAULT_STATE, type ExtensionState } from "./types.js";

const STORAGE_KEY = "neo_state";

/**
 * All persisted state lives in one JSON blob under `storage.local` (never `storage.sync`,
 * `_specs/browser-extension.md` "Storage"). `updateState` serializes read-modify-write calls
 * through a per-process promise chain so concurrent callers in the same service-worker
 * instance never clobber each other; a restart just re-reads from disk.
 */
let chain: Promise<unknown> = Promise.resolve();

function readRaw(): Promise<Partial<ExtensionState> | undefined> {
  return browser.storage.local.get(STORAGE_KEY).then((r) => r[STORAGE_KEY] as Partial<ExtensionState> | undefined);
}

export async function getState(): Promise<ExtensionState> {
  const stored = await readRaw();
  return { ...DEFAULT_STATE, ...stored };
}

async function writeState(state: ExtensionState): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: state });
}

/** Reads, applies `mutator`, writes back, and returns the new state. Serialized per worker instance. */
export function updateState(mutator: (state: ExtensionState) => ExtensionState | void): Promise<ExtensionState> {
  const next = chain.then(async () => {
    const current = await getState();
    const result = mutator(current);
    const state = result ?? current;
    await writeState(state);
    return state;
  });
  // Keep the chain alive even if this call rejects, so later callers still run in order.
  chain = next.catch(() => undefined);
  return next;
}

/** Test-only escape hatch: resets the in-process write queue between tests. */
export function __resetStateChainForTests(): void {
  chain = Promise.resolve();
}
