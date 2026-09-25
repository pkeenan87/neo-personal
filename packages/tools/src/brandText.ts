import { GENERIC_KEYWORDS } from "./brands.js";
import { skeleton } from "./checks/lookalike.js";
import { registrableOf } from "./checks/normalize.js";
import type { Brand } from "./types.js";
import { stripInvisible } from "./text.js";

/** Words that must follow a generic brand name ("Chase account", "Target order") before it counts as a brand claim. */
const BRAND_CONTEXT = new Set([
  "bank", "banking", "card", "cards", "account", "accounts", "credit", "debit", "order", "orders", "pay", "payment", "payments",
  "alert", "alerts", "support", "security", "online", "app", "rewards", "delivery", "team", "customer", "service", "services",
  "fraud", "member", "membership", "id", "wallet", "prime", "notification", "notifications", "billing", "mobile",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Matcher = { brand: Brand; test: (raw: string, lower: string, tokens: string[]) => boolean };

const cache = new WeakMap<Brand[], Matcher[]>();

function isAllCaps(name: string): boolean {
  return /[A-Z]/.test(name) && !/[a-z]/.test(name);
}

function buildMatchers(brands: Brand[]): Matcher[] {
  const cached = cache.get(brands);
  if (cached) return cached;
  const matchers: Matcher[] = brands.map((brand) => {
    const name = brand.name;
    const generic = GENERIC_KEYWORDS.has(name.toLowerCase().replace(/[^a-z0-9]/g, "")) || GENERIC_KEYWORDS.has(name.toLowerCase());
    const nameRe = isAllCaps(name)
      ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, "u")
      : generic
        ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}\\s+([A-Za-z]+)`, "gu")
        : new RegExp(`(?<![a-z0-9])${escapeRe(name.toLowerCase())}(?![a-z0-9])`, "u");
    const keywords = brand.keywords.filter((k) => k.length >= 5 && !GENERIC_KEYWORDS.has(k));
    return {
      brand,
      test: (raw, lower, tokens) => {
        if (isAllCaps(name)) {
          if (nameRe.test(raw)) return true;
        } else if (generic) {
          nameRe.lastIndex = 0;
          for (const m of raw.matchAll(nameRe)) if (BRAND_CONTEXT.has((m[1] ?? "").toLowerCase())) return true;
        } else if (nameRe.test(lower)) {
          return true;
        }
        return keywords.some((k) => tokens.includes(k));
      },
    };
  });
  cache.set(brands, matchers);
  return matchers;
}

/**
 * Find the first brand the text claims to be (brand name as a phrase, or a
 * distinctive brand keyword as a whole token). Generic names (Chase, Target)
 * need a context word ("Chase account"); all-caps names (USPS, UPS, IRS) are
 * matched case-sensitively. With `lookalike: true` (display names), tokens
 * are also compared by visual skeleton, so "PayPaI" or "Micros0ft" match.
 */
export function findBrandInText(text: string, brands: Brand[], opts: { lookalike?: boolean } = {}): Brand | undefined {
  const raw = stripInvisible(text.normalize("NFKC"));
  if (!raw.trim()) return undefined;
  const lower = raw.toLowerCase();
  const tokens = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const joined = tokens.join("");
  for (const m of buildMatchers(brands)) if (m.test(raw, lower, tokens)) return m.brand;
  if (opts.lookalike) {
    const skTokens = new Set(tokens.filter((t) => t.length >= 4).map(skeleton));
    if (joined.length >= 4 && joined.length <= 40) skTokens.add(skeleton(joined));
    for (const brand of brands) {
      for (const k of brand.keywords) {
        if (k.length < 5 || GENERIC_KEYWORDS.has(k)) continue;
        if (skTokens.has(skeleton(k))) return brand;
      }
    }
  }
  return undefined;
}

/** True when `host` (or its registrable domain) belongs to the brand. */
export function brandOwnsDomain(brand: Brand, host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  const reg = registrableOf(h).registrable;
  return brand.domains.some((d) => h === d || h.endsWith(`.${d}`) || (reg !== "" && registrableOf(d).registrable === reg));
}
