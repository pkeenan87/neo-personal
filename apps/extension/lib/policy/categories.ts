/**
 * Downloading, verifying and indexing the category lists (`_specs/v2-m2-child.md` section 5).
 * `GET /api/signals/lists` names each file with its SHA-256; a file is stored under that hash after
 * its bytes are checked against it, so a corrupt or swapped download is never used and an unchanged
 * file is never fetched twice.
 */
import type { CategoryListsInfo } from "@neo/tools/browser";
import type { WebCategory } from "@neo/verdict";
import { binarySearch, decodeBin, type PrefixLookup } from "./match.js";
import { binStore, type BinStore } from "./store.js";

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Category -> SHA-256 of the file the matcher uses. Only complete downloads are recorded. */
export type CategoryData = { version: string; shas: Partial<Record<WebCategory, string>> };

export type FetchBytes = (url: string) => Promise<ArrayBuffer | null>;

export const fetchBytes: FetchBytes = async (url) => {
  try {
    const res = await fetch(url);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
};

/** An http(s) URL directory with a trailing slash; the files are resolved against it. */
function validBase(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  } catch {
    return null;
  }
}

/**
 * Makes sure the files for `wanted` categories are in `store` (downloading the missing ones and
 * checking each against the manifest's SHA-256 and count), and drops stored files nothing refers to.
 * `complete` is false when any wanted file is missing from the manifest, failed its check, or could
 * not be fetched; `data` then lists only what is usable.
 */
export async function syncCategoryLists(
  info: CategoryListsInfo | undefined,
  wanted: readonly WebCategory[],
  deps: { store?: BinStore; fetchBytes?: FetchBytes } = {},
): Promise<{ data: CategoryData | null; complete: boolean }> {
  const store = deps.store ?? binStore();
  const download = deps.fetchBytes ?? fetchBytes;
  if (wanted.length === 0) {
    // Nothing is needed: free the space.
    for (const key of await store.keys()) await store.delete(key);
    return { data: null, complete: true };
  }
  const base = info ? validBase(info.baseUrl) : null;
  if (!info || !base) return { data: null, complete: false };

  const shas: Partial<Record<WebCategory, string>> = {};
  let complete = true;
  for (const category of wanted) {
    const entry = info.categories[category];
    if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256) || !/^[a-z0-9_-]+\.bin$/.test(entry.file)) {
      complete = false;
      continue;
    }
    if ((await store.get(entry.sha256)) === undefined) {
      const bytes = await download(`${base}${entry.file}`);
      const ok = bytes !== null && bytes.byteLength === entry.count * 4 && (await sha256Hex(bytes)) === entry.sha256;
      if (!ok) {
        complete = false;
        continue;
      }
      await store.put(entry.sha256, bytes);
    }
    shas[category] = entry.sha256;
  }
  const keep = new Set(Object.values(shas));
  for (const key of await store.keys()) if (!keep.has(key)) await store.delete(key);
  return { data: Object.keys(shas).length ? { version: info.version, shas } : null, complete };
}

const decoded = new Map<string, Uint32Array>();

/** A `PrefixLookup` over the stored files named by `data`; a category whose file is missing never matches. */
export function createPrefixLookup(data: CategoryData | null | undefined, store: BinStore = binStore()): PrefixLookup {
  return async (category, prefix) => {
    const sha = data?.shas[category];
    if (!sha) return false;
    let arr = decoded.get(sha);
    if (!arr) {
      const bytes = await store.get(sha);
      const parsed = bytes ? decodeBin(bytes) : null;
      if (!parsed) return false;
      arr = parsed;
      decoded.set(sha, arr);
    }
    return binarySearch(arr, prefix);
  };
}

export function __clearDecodedForTests(): void {
  decoded.clear();
}
