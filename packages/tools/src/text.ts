/**
 * Text helpers shared by the email and SMS analyzers. Everything these
 * functions see is attacker-controlled; they only normalize, measure, and
 * bound it (no evaluation, no rendering).
 */

/** Bidi overrides/isolates and marks: used to disguise file extensions and names (RTLO). */
const BIDI_CHARS = "\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069";
/** Zero-width and other invisible formatting characters. */
const ZERO_WIDTH_CHARS = "\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200D\\u2060-\\u2064\\u206A-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0";
// C0/C1 controls except tab/newline/CR
const CONTROL_CHARS = "\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F";

// The classes deliberately list combining/invisible code points one by one.
/* eslint-disable no-misleading-character-class */
const TRICK_RE = new RegExp(`[${BIDI_CHARS}${ZERO_WIDTH_CHARS}${CONTROL_CHARS}]`, "u");
const TRICK_RE_G = new RegExp(`[${BIDI_CHARS}${ZERO_WIDTH_CHARS}${CONTROL_CHARS}]`, "gu");
const BIDI_RE = new RegExp(`[${BIDI_CHARS}]`, "u");
/* eslint-enable no-misleading-character-class */

/** True when the string contains bidi overrides, zero-width, or control characters. */
export function hasUnicodeTricks(s: string): boolean {
  return TRICK_RE.test(s);
}

/** True when the string contains bidi override/isolate characters (RTLO and friends). */
export function hasBidiOverride(s: string): boolean {
  return BIDI_RE.test(s);
}

/** Remove bidi, zero-width, and control characters (keeps tab/newline/CR). */
export function stripInvisible(s: string): string {
  return s.replace(TRICK_RE_G, "");
}

/** Replace invisible characters with a visible `[U+XXXX]` marker (for names shown to the model). */
export function escapeInvisible(s: string): string {
  return s.replace(TRICK_RE_G, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
}

/** Truncate to at most `max` characters (by code unit, never splitting a surrogate pair). */
export function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 1;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}\u2026`;
}

/** Single-line, invisible-free, trimmed and bounded (display names, subjects, filenames). */
export function cleanLine(s: string, max = 300): string {
  return clamp(stripInvisible(s).replace(/\s+/g, " ").trim(), max);
}

/** Lowercase, NFKC, invisible-free, single-spaced text for keyword matching. */
export function normalizeForMatch(s: string): string {
  return stripInvisible(s.normalize("NFKC")).replace(/[\u2018\u2019\u02BC]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Compile JSON-stored regex sources (case-insensitive, unicode). Invalid sources are skipped. */
export function compilePatterns(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, "iu"));
    } catch {
      /* a bad pattern in a data file must not break analysis */
    }
  }
  return out;
}

/** Codes whose patterns match `text` (already normalized), in table order. */
export function matchSignals(text: string, table: ReadonlyArray<readonly [string, RegExp[]]>): string[] {
  const hits: string[] = [];
  for (const [code, patterns] of table) if (patterns.some((re) => re.test(text))) hits.push(code);
  return hits;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "\u200C",
  zwj: "\u200D", shy: "\u00AD", lrm: "\u200E", rlm: "\u200F", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
  bull: "\u2022", middot: "\u00B7", euro: "\u20AC", pound: "\u00A3", yen: "\u00A5", cent: "\u00A2", laquo: "\u00AB",
  raquo: "\u00BB", times: "\u00D7", sol: "/", colon: ":", period: ".", commat: "@", lowbar: "_", num: "#", excl: "!",
};

/** Decode HTML character references (named subset + numeric). Never produces markup semantics. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (m, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\uFFFD";
      return String.fromCodePoint(n);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * Deep-copy a JSON value with every string bounded to `max` characters and
 * `undefined` properties removed (keeps tool output small and serializable).
 */
export function boundStrings<T>(value: T, max = 2048): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return clamp(v, max);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Share of letters that are outside the Latin script (0..1); 0 when there are no letters. */
export function nonLatinLetterRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  const nonLatin = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
  return nonLatin / letters.length;
}
