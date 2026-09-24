import { domainToUnicode } from "node:url";
import { isIP } from "node:net";
import { BRANDS, GENERIC_KEYWORDS } from "../brands.js";
import type { Brand, Lookalike, LookalikeTechnique } from "../types.js";
import { registrableOf } from "./normalize.js";

/** Single-character confusables (Cyrillic, Greek, IPA, Latin extensions) -> Latin. */
const CONFUSABLES: Record<string, string> = {
  а: "a", ɑ: "a", α: "a", ạ: "a",
  Ь: "b", ƅ: "b", ь: "b",
  с: "c", ϲ: "c", ċ: "c",
  ԁ: "d", ɗ: "d",
  е: "e", ё: "e", ε: "e", ҽ: "e",
  ɡ: "g", ց: "g",
  һ: "h", հ: "h",
  і: "l", ї: "l", ı: "l", ɩ: "l", ι: "l", í: "l", ӏ: "l", ʟ: "l", "|": "l", "!": "l",
  ј: "j", ȷ: "j", ϳ: "j",
  к: "k", κ: "k",
  ո: "n", η: "n", п: "n",
  о: "o", ο: "o", ө: "o", ɵ: "o", օ: "o", σ: "o",
  р: "p", ρ: "p",
  ԛ: "q",
  г: "r",
  ѕ: "s",
  т: "t", τ: "t",
  υ: "u", ս: "u", ц: "u",
  ν: "v", ѵ: "v", ᴠ: "v",
  ԝ: "w", ѡ: "w", ᴡ: "w", ω: "w",
  х: "x", χ: "x",
  у: "y", ү: "y", γ: "y",
  ᴢ: "z",
};

/**
 * Collapse a label to a "visual skeleton" so that lookalikes compare equal:
 * strip diacritics, map confusables, and fold the classic ASCII tricks
 * (rn->m, vv->w, 0->o, 1/i/l->l, 5->s, 3->e).
 */
export function skeleton(label: string): string {
  let s = label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  s = [...s].map((ch) => CONFUSABLES[ch] ?? ch).join("");
  s = s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
  s = s.replace(/0/g, "o").replace(/[1i]/g, "l").replace(/5/g, "s").replace(/3/g, "e");
  return s;
}

/** Optimal-string-alignment Damerau-Levenshtein distance. */
export function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

/** Words phishers glue onto brand names (paypal-verify, securepaypal, appleid-support-center). */
export const PHISHING_AFFIXES = new Set([
  "login", "logon", "signin", "sign", "in", "verify", "verification", "secure", "security", "account", "accounts",
  "update", "confirm", "support", "help", "helpdesk", "service", "services", "online", "billing", "pay", "payment",
  "auth", "id", "wallet", "alert", "alerts", "center", "centre", "team", "customer", "care", "notice", "recovery",
  "unlock", "limited", "access", "portal", "web", "app", "mail", "check", "claim", "refund", "rewards", "gift",
  "bonus", "delivery", "track", "tracking", "parcel", "package", "shipment", "invoice", "resolution", "case",
  "official", "my", "us", "usa", "info", "net", "mobile", "sso", "safe", "protect", "protection", "reset", "review",
  "status", "desk", "cloud", "live", "connect", "event", "promo", "prize", "free", "airdrop", "sync", "restore",
]);

function isAffixWords(rest: string): boolean {
  if (!rest) return false;
  const s = rest.replace(/\d+/g, "");
  if (!s) return true; // paypal2024
  const ok: boolean[] = new Array<boolean>(s.length + 1).fill(false);
  ok[0] = true;
  for (let i = 1; i <= s.length; i++) {
    for (let j = Math.max(0, i - 14); j < i && !ok[i]; j++) if (ok[j] && PHISHING_AFFIXES.has(s.slice(j, i))) ok[i] = true;
  }
  return ok[s.length] === true;
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isCountryCodeSuffix(publicSuffix: string): boolean {
  const last = publicSuffix.split(".").pop() ?? "";
  return last.length === 2;
}

type Candidate = { brand: Brand; keyword: string };

function candidates(brands: Brand[]): Candidate[] {
  return brands.flatMap((brand) => brand.keywords.map((keyword) => ({ brand, keyword })));
}

function hit(brand: Brand, technique: LookalikeTechnique): Lookalike {
  return { brand: brand.name, technique, brand_domain: brand.domains[0] ?? "" };
}

/**
 * Detect a host that imitates a known brand. Returns null for the brand's own
 * domains (and their subdomains) and for hosts that do not resemble any brand.
 */
export function detectLookalike(hostInput: string, brands: Brand[] = BRANDS): Lookalike | null {
  const host = hostInput.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host || isIP(host)) return null;
  for (const b of brands) if (b.domains.some((d) => hostMatchesDomain(host, d))) return null;

  const { registrable, subdomain, public_suffix } = registrableOf(host);
  if (!registrable || !public_suffix) return null;
  const labelAscii = registrable.slice(0, -(public_suffix.length + 1));
  const label = domainToUnicode(labelAscii) || labelAscii;
  const labelFlat = label.replace(/-/g, "");
  const tokens = label.split("-").filter(Boolean);
  const subUnicode = subdomain ? domainToUnicode(subdomain) || subdomain : "";
  const subTokens = subUnicode.split(/[.-]/).filter(Boolean);
  const all = candidates(brands);

  // 1. Homoglyph: renders like the brand but is not literally the brand.
  for (const { brand, keyword } of all) {
    if (keyword.length < 4) continue;
    const sk = skeleton(keyword);
    if (labelFlat !== keyword && skeleton(labelFlat) === sk) return hit(brand, "homoglyph");
    if (tokens.some((t) => t !== keyword && skeleton(t) === sk)) return hit(brand, "homoglyph");
  }

  // 2. Brand used as a subdomain of an unrelated domain (paypal.com.secure-login.xyz).
  if (subTokens.length) {
    for (const { brand, keyword } of all) {
      const generic = GENERIC_KEYWORDS.has(keyword);
      if (generic || keyword.length < 4) {
        if (brand.domains.some((d) => `.${subUnicode}.`.includes(`.${d}.`))) return hit(brand, "brand_in_subdomain");
        continue;
      }
      if (subTokens.some((t) => t === keyword || skeleton(t) === skeleton(keyword))) return hit(brand, "brand_in_subdomain");
    }
  }

  // 3. Exact brand label on a TLD the brand does not use (paypal.co, netflix.xyz).
  for (const { brand, keyword } of all) {
    if (GENERIC_KEYWORDS.has(keyword) || labelFlat !== keyword || tokens.length > 1) continue;
    // Brands that register their main name under many ccTLDs (google.de, amazon.fr).
    if (brand.ccTLDs && isCountryCodeSuffix(public_suffix) && keyword === brand.domains[0]?.split(".")[0]) continue;
    return hit(brand, "tld_swap");
  }

  // 4. Brand plus phishing-style affix (paypal-verify.com, appleidsupport.net).
  for (const { brand, keyword } of all) {
    const generic = GENERIC_KEYWORDS.has(keyword);
    if (tokens.length > 1 && tokens.includes(keyword)) {
      const others = tokens.filter((t) => t !== keyword);
      if ((!generic && keyword.length >= 4) || others.some((t) => isAffixWords(t))) return hit(brand, "brand_with_affix");
    }
    if (keyword.length >= 4 && labelFlat !== keyword) {
      if (labelFlat.startsWith(keyword) && isAffixWords(labelFlat.slice(keyword.length))) return hit(brand, "brand_with_affix");
      if (labelFlat.endsWith(keyword) && isAffixWords(labelFlat.slice(0, -keyword.length))) return hit(brand, "brand_with_affix");
    }
  }

  // 5. Typosquat: small edit distance to a distinctive brand name.
  //    Brands under 8 chars allow distance 1 (amazon vs amazing would otherwise match).
  if (labelFlat.length >= 6) {
    const keywordSet = new Set(all.map((c) => c.keyword));
    if (!keywordSet.has(labelFlat)) {
      for (const { brand, keyword } of all) {
        if (keyword.length < 6 || GENERIC_KEYWORDS.has(keyword)) continue;
        const max = keyword.length >= 8 ? 2 : 1;
        const targets = [labelFlat, ...tokens.filter((t) => t.length >= 6)];
        if (targets.some((t) => t !== keyword && damerauLevenshtein(t, keyword) <= max)) return hit(brand, "typosquat");
      }
    }
  }

  return null;
}
