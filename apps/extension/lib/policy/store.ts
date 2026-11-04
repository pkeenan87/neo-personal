/**
 * Where the downloaded category `.bin` files live. IndexedDB, not `storage.local`: the files are
 * several MB, `storage.local` is capped at 10 MB in Chrome and already holds the detection lists and
 * the event queue, and IndexedDB needs no extra permission (so no `unlimitedStorage` install warning).
 * Entries are content-addressed by their SHA-256, so a changed list is simply a new key.
 */
export interface BinStore {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  keys(): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** A Map-backed store, for tests and as the fallback when IndexedDB is unavailable. */
export class MemoryBinStore implements BinStore {
  private readonly map = new Map<string, ArrayBuffer>();
  async get(key: string) {
    return this.map.get(key);
  }
  async put(key: string, bytes: ArrayBuffer) {
    this.map.set(key, bytes);
  }
  async keys() {
    return [...this.map.keys()];
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

const DB_NAME = "neo-category-lists";
const STORE = "bins";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbBinStore implements BinStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.dbPromise;
  }

  async get(key: string) {
    const db = await this.db();
    return (await request(db.transaction(STORE).objectStore(STORE).get(key))) as ArrayBuffer | undefined;
  }
  async put(key: string, bytes: ArrayBuffer) {
    const db = await this.db();
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(bytes, key));
  }
  async keys() {
    const db = await this.db();
    return (await request(db.transaction(STORE).objectStore(STORE).getAllKeys())).map(String);
  }
  async delete(key: string) {
    const db = await this.db();
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key));
  }
}

let shared: BinStore | null = null;
/** The extension's store: IndexedDB when it exists, else memory (the lists are then re-downloaded per worker start). */
export function binStore(): BinStore {
  shared ??= typeof indexedDB !== "undefined" ? new IndexedDbBinStore() : new MemoryBinStore();
  return shared;
}
export function __setBinStoreForTests(store: BinStore | null): void {
  shared = store;
}
