/** Control, bidi-override/isolate and zero-width characters (same classes as @neo/tools text.ts stripInvisible). */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2066-\u2069\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/gu;

/** Single-line, invisible-free, bounded. Stored values are already sanitized; this is defence in depth at the output edge. */
export function cleanValue(s: string, max = 80): string {
  const v = s.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
