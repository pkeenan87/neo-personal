export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return "timed out";
    if (e.name === "AbortError") return "aborted";
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !e.message.includes(cause.message)) return `${e.message} (${cause.message})`;
    return e.message;
  }
  return String(e);
}

/** A signal that aborts when the parent aborts or after `ms`. */
export function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, t]) : t;
}

/** Reject if the promise does not settle within `ms` (for work that cannot take a signal). */
export function withDeadline<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Run one independent check. Never throws: failures are appended to `errors`
 * as `"<name>: <message>"` and yield `undefined`.
 */
export async function runCheck<T>(name: string, errors: string[], fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${name}: ${errorMessage(e)}`);
    return undefined;
  }
}

export function envKey(env: Record<string, string | undefined>, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`invalid JSON (HTTP ${res.status})`);
  }
}

export const DAY_MS = 86_400_000;

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
