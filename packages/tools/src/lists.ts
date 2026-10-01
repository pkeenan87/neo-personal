import { createHash } from "node:crypto";
import remoteAccessToolsData from "./data/remote-access-tools.json" with { type: "json" };
import pupPublishersData from "./data/pup-publishers.json" with { type: "json" };
import scamPagePhrasesData from "./data/scam-page-phrases.json" with { type: "json" };
import skipDomainsData from "./data/skip-domains.json" with { type: "json" };
import { BRANDS, brandId } from "./brands.js";
import type { DetectionListsPayload, ListBrand, PupPublisher, RemoteAccessTool, ScamPagePhrase, ScamPhraseKind, SessionEvidence } from "./listsTypes.js";

export type { DetectionListsPayload, ListBrand, PupPublisher, RemoteAccessTool, ScamPagePhrase, ScamPhraseKind, SessionEvidence };

export const REMOTE_ACCESS_TOOLS: readonly RemoteAccessTool[] = remoteAccessToolsData.tools as RemoteAccessTool[];

export const PUP_PUBLISHERS: readonly PupPublisher[] = pupPublishersData.publishers as PupPublisher[];

export const SCAM_PAGE_PHRASES: readonly ScamPagePhrase[] = scamPagePhrasesData.phrases as ScamPagePhrase[];

export const SKIP_DOMAINS: readonly string[] = skipDomainsData.domains as string[];

/**
 * Registrable domains that serve pages written by anyone (hosted sites, buckets, forms, shared files).
 * They must never be skipped: a fake PayPal login on `x.github.io` or in an S3 bucket is exactly what the
 * lookalike-login heuristic exists for, even though the host belongs to a brand in BRANDS.
 */
export const USER_CONTENT_HOSTS: readonly string[] = [
  "amazonaws.com",
  "blogspot.com",
  "box.com",
  "github.io",
  "githubusercontent.com",
  "google.com",
  "linktr.ee",
  "medium.com",
  "sharepoint.com",
  "wordpress.com",
];

const remoteAccessToolsById = new Map(REMOTE_ACCESS_TOOLS.map((t) => [t.id, t]));

/** Looks up a remote-access tool by its stable id (e.g. `anydesk`). */
export function findRemoteAccessTool(id: string): RemoteAccessTool | undefined {
  return remoteAccessToolsById.get(id);
}

/** `BRANDS` shaped for the wire, with a stable `id` (see `brandId`, `_specs/browser-extension.md`). */
export const BRAND_LIST: readonly ListBrand[] = BRANDS.map(({ name, domains, keywords }) => ({ id: brandId(name), name, domains, keywords }));

/** Kept as an alias so existing imports (`apps/web/lib/signal-types.ts`) are unaffected by the `brands` addition. */
export type DetectionLists = DetectionListsPayload;

/** Deterministically orders object keys so JSON.stringify output is stable regardless of insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

let cached: DetectionLists | undefined;

/** The five detection lists plus a stable content-hash `version` (16 hex chars). Memoized. */
export function detectionLists(): DetectionLists {
  if (cached) return cached;
  const canonicalJson = JSON.stringify(
    canonicalize({
      remoteAccessTools: REMOTE_ACCESS_TOOLS,
      pupPublishers: PUP_PUBLISHERS,
      scamPagePhrases: SCAM_PAGE_PHRASES,
      skipDomains: SKIP_DOMAINS,
      brands: BRAND_LIST,
    }),
  );
  const version = createHash("sha256").update(canonicalJson, "utf8").digest("hex").slice(0, 16);
  cached = {
    version,
    remoteAccessTools: REMOTE_ACCESS_TOOLS,
    pupPublishers: PUP_PUBLISHERS,
    scamPagePhrases: SCAM_PAGE_PHRASES,
    skipDomains: SKIP_DOMAINS,
    brands: BRAND_LIST,
  };
  return cached;
}
