/** Crockford base32, lowercase (no i, l, o, u). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** "check-" + 12 crypto-random lowercase Crockford base32 characters (60 bits). */
export function generateLocalPart(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "check-";
  for (const b of bytes) s += ALPHABET[b & 31];
  return s;
}

const LOCAL_PART_RE = /^check-[0-9abcdefghjkmnpqrstvwxyz]{12}$/;

/** Cheap shape check before any database lookup. */
export function isInboundLocalPart(v: string): boolean {
  return LOCAL_PART_RE.test(v);
}
