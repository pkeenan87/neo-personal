/**
 * What household memory may hold (_specs/v2-m3-cutover.md section 3). Memory is a prompt-injection
 * persistence channel, so a stored fact is one short line of plain words: no contact details, links,
 * credentials or payment data, and no characters that hide or reshape text. The check runs on the
 * server for every write, whether the owner typed the text in the console or approved the `remember`
 * tool. It is a blocklist, so it errs towards refusing: a refusal costs the owner a rewording.
 *
 * Pure; imports nothing from Next, so the eve server can bundle it.
 */
import { HOUSEHOLD_MEMORY_TEXT_MAX } from "@neo/db";

export type MemoryRejection = "empty" | "too_long" | "control_characters" | "contact_details" | "link" | "credentials" | "payment_data";

export type MemoryTextCheck = { ok: true; text: string } | { ok: false; code: MemoryRejection; message: string };

const MESSAGES: Record<MemoryRejection, string> = {
  empty: "Write what Neo should remember.",
  too_long: `Keep it to ${HOUSEHOLD_MEMORY_TEXT_MAX} characters or fewer.`,
  control_characters: "Use plain words on one line, with no hidden or special characters.",
  contact_details: "Neo does not keep email addresses, handles or phone numbers. Say who to call by name instead.",
  link: "Neo does not keep links or web addresses. Describe the site or app in words.",
  credentials: "Neo does not keep passwords, codes, keys or other secrets.",
  payment_data: "Neo does not keep card, bank or other account numbers.",
};

// Control characters (including newlines and tabs), format characters (zero-width, bidi overrides, tags),
// line and paragraph separators, and private-use code points.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/u;
// Any "@" is an address or a handle.
const AT_SIGN = /[@＠﹫]/u;
// Seven or more digits, possibly split by spaces, dots, dashes or brackets: phone, card and bank numbers.
const DIGIT_RUN = /\+?\d(?:[\s().\-_/]*\d){6,}/u;
const URL_SCHEME = /\b[a-z][a-z0-9+.-]{1,15}:\/\//i;
const URL_SCHEMES = /\b(?:https?|ftp|file|data|javascript|mailto|tel|sms|www)\s*[:.]/i;
const TLDS =
  "com|net|org|edu|gov|info|biz|io|co|me|app|dev|xyz|top|online|site|shop|store|live|link|ly|cc|tv|us|uk|ca|au|de|fr|nl|ru|cn|in|jp|br|es|it|se|ch|eu|ie|nz|za|ws|to|gl|gd|su|tk|ml|ga|cf|click|support|help|zip|mov|pro|cloud|tech|club|vip|work";
const BARE_DOMAIN = new RegExp(`\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.(?:${TLDS})\\b`, "i");
const SECRET_WORDS =
  /\b(?:passwords?|passcodes?|passphrases?|pass\s*codes?|pin\s*(?:code|number|is)|pin\s*:|otp|one[\s-]*time\s*(?:code|password)|verification\s*code|security\s*code|recovery\s*(?:code|key|phrase)|seed\s*phrase|secret|api[\s_-]*key|access\s*key|private\s*key|token|credentials?|login\s*(?:details|info)|cvv|cvc|2fa\s*code)\b/i;
// Token-like strings: key prefixes, long unbroken mixed runs.
const KEY_PREFIX = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abpr]|AKIA|ASIA|AIza|eyJ)[-_A-Za-z0-9]{8,}/;
const LONG_RUN = /[A-Za-z0-9_\-+/=]{24,}/;
const PRIVATE_KEY = /-----BEGIN/i;
const PAYMENT_WORDS =
  /\b(?:(?:credit|debit|bank|gift)\s*cards?|card\s*(?:number|no\b|#)|(?:bank\s*)?account\s*(?:number|no\b|#)|routing\s*(?:number|no\b)|sort\s*code|iban|swift|bic|ssn|social\s*security|tax\s*file|national\s*insurance|medicare\s*number|paypal|venmo|zelle|crypto\s*wallet|wallet\s*address|bitcoin\s*address)\b/i;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/;

/** Check, and normalize, the text of one memory. Trims the ends and returns the trimmed text. */
export function checkMemoryText(input: unknown): MemoryTextCheck {
  const bad = (code: MemoryRejection): MemoryTextCheck => ({ ok: false, code, message: MESSAGES[code] });
  if (typeof input !== "string") return bad("empty");
  const text = input.trim();
  if (text.length === 0) return bad("empty");
  if ([...text].length > HOUSEHOLD_MEMORY_TEXT_MAX) return bad("too_long");
  if (HIDDEN.test(text)) return bad("control_characters");
  // NFKC folds look-alikes (full-width letters and digits, circled digits) before the pattern checks.
  const folded = text.normalize("NFKC");
  if (AT_SIGN.test(text) || AT_SIGN.test(folded)) return bad("contact_details");
  if (PRIVATE_KEY.test(folded) || KEY_PREFIX.test(folded) || SECRET_WORDS.test(folded)) return bad("credentials");
  if (URL_SCHEME.test(folded) || URL_SCHEMES.test(folded) || BARE_DOMAIN.test(folded)) return bad("link");
  if (PAYMENT_WORDS.test(folded) || IBAN.test(folded)) return bad("payment_data");
  if (DIGIT_RUN.test(folded)) return bad("contact_details");
  if (LONG_RUN.test(folded)) return bad("credentials");
  return { ok: true, text };
}
