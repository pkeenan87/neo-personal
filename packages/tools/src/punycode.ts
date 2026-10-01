/**
 * RFC 3492 punycode decoder (bootstring), written in-repo so `@neo/tools/browser` never depends
 * on `node:url`'s `domainToUnicode`. Decode-only: Neo never needs to *encode* to punycode.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = "-";

/** RFC 3492 §3.2 "bias adaptation function". */
function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

/** `0-9A-Za-z` -> its digit value (0-35), or `BASE` when the code point is not a punycode digit. */
function basicToDigit(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30 + 26; // 0-9
  if (codePoint >= 0x41 && codePoint <= 0x5a) return codePoint - 0x41; // A-Z
  if (codePoint >= 0x61 && codePoint <= 0x7a) return codePoint - 0x61; // a-z
  return BASE;
}

/**
 * Decode one punycode-encoded label body (the part after the `xn--` / `punycode`prefix has
 * already been stripped). Throws on malformed input; callers should catch and fall back to the
 * original (still-encoded) label.
 */
export function decodePunycode(input: string): string {
  const output: number[] = [];
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;

  const lastDelim = input.lastIndexOf(DELIMITER);
  const basicLength = lastDelim < 0 ? 0 : lastDelim;
  for (let j = 0; j < basicLength; j++) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) throw new Error("invalid punycode input: non-ASCII in basic part");
    output.push(code);
  }

  let index = basicLength > 0 ? basicLength + 1 : 0;
  const inputLength = input.length;

  while (index < inputLength) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= inputLength) throw new Error("invalid punycode input: truncated");
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= BASE) throw new Error("invalid punycode input: bad digit");
      if (digit > Math.floor((Number.MAX_SAFE_INTEGER - i) / w)) throw new Error("invalid punycode input: overflow");
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(Number.MAX_SAFE_INTEGER / (BASE - t))) throw new Error("invalid punycode input: overflow");
      w *= BASE - t;
    }
    const outLength = output.length + 1;
    bias = adapt(i - oldi, outLength, oldi === 0);
    if (Math.floor(i / outLength) > 0x10ffff - n) throw new Error("invalid punycode input: overflow");
    n += Math.floor(i / outLength);
    i %= outLength;
    output.splice(i, 0, n);
    i++;
  }

  return String.fromCodePoint(...output);
}

/**
 * Decode every `xn--` label of a (lowercase) host to Unicode, RFC 3492 only (no case-folding or
 * other IDNA normalization). A label that isn't valid punycode is returned unchanged. Matches
 * `node:url`'s `domainToUnicode` for ordinary hosts; see `packages/tools/test/browser-entry.test.ts`.
 */
export function toUnicodeHost(host: string): string {
  return host
    .split(".")
    .map((label) => {
      const lower = label.toLowerCase();
      if (!lower.startsWith("xn--")) return label;
      try {
        return decodePunycode(lower.slice(4));
      } catch {
        return label;
      }
    })
    .join(".");
}
