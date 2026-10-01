/**
 * Lookalike-login detector (`_specs/browser-extension.md` "Detectors", `page`/`lookalike_login`).
 * Pure evaluation of a host against the detection lists; the content script decides *when* to
 * call it (a password field present or appearing) and owns the per-domain send-once-per-hour and
 * "wait for the server" rules (`lib/queue.ts`, `entrypoints/content-detect.ts`).
 */
import { brandId, detectLookalike, registrableDomain } from "@neo/tools/browser";
import type { Brand } from "@neo/tools/browser";
import type { LookalikeIndicator } from "@neo/verdict";

export interface LookalikeEvaluation {
  /** Always includes `password_field`; `null` when nothing beyond that fired (never sent). */
  indicators: LookalikeIndicator[];
  /** The list's brand id (`brandId(name)`), set only when `detectLookalike` found a match. */
  brand?: string;
  domain: string;
}

/**
 * Evaluates a host that has a password field. Returns `null` when the domain is in `skipDomains`
 * (suppresses only this heuristic, per `_specs/signals.md` "Detection lists") or when the host has
 * no registrable domain. Returns an evaluation with only `password_field` when nothing else
 * matched — the caller must not send that alone (schema requires `brand`, spec: "a password field
 * alone is never sent").
 */
export function evaluateLookalike(host: string, brands: readonly Brand[], skipDomains: readonly string[]): LookalikeEvaluation | null {
  const info = registrableDomain(host);
  if (!info || info.isIp) return null;
  if (skipDomains.includes(info.registrable)) return null;

  const indicators: LookalikeIndicator[] = ["password_field"];

  const hasPunycode = host
    .toLowerCase()
    .split(".")
    .some((label) => label.startsWith("xn--"));
  if (hasPunycode) indicators.push("punycode");

  const hit = detectLookalike(host, brands as Brand[]);
  let brand: string | undefined;
  if (hit) {
    brand = brandId(hit.brand);
    // The schema's LOOKALIKE_INDICATORS only distinguish "brand appears in an unrelated
    // subdomain" from every other lookalike technique (homoglyph, typosquat, tld_swap,
    // brand_with_affix), which all collapse to `lookalike_skeleton`.
    indicators.push(hit.technique === "brand_in_subdomain" ? "brand_in_subdomain" : "lookalike_skeleton");
  }

  return { indicators, brand, domain: info.registrable };
}

/** True when `evaluateLookalike` found something worth sending (schema requires `brand`). */
export function isSendableLookalikeHit(evaluation: LookalikeEvaluation): evaluation is LookalikeEvaluation & { brand: string } {
  return evaluation.brand !== undefined && evaluation.indicators.length > 1;
}
