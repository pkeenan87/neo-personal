import { createHash } from "node:crypto";
import remoteAccessToolsData from "./data/remote-access-tools.json" with { type: "json" };
import pupPublishersData from "./data/pup-publishers.json" with { type: "json" };
import scamPagePhrasesData from "./data/scam-page-phrases.json" with { type: "json" };
import skipDomainsData from "./data/skip-domains.json" with { type: "json" };

/** One remote-access tool's install/session signatures (`_specs/signals.md`, Detection lists). */
export interface RemoteAccessTool {
  id: string;
  name: string;
  vendorDomains: string[];
  /** Installer filename regex sources (no flags stored; matched case-insensitively). */
  installerPatterns: string[];
  windows: {
    publishers: string[];
    displayNamePatterns: string[];
    serviceNames: string[];
    processNames: string[];
  };
  macos: {
    bundleIds: string[];
    teamIds: string[];
  };
  /** Process or log markers the desktop agent uses to infer an active session. */
  sessionHints: string[];
}

export interface PupPublisher {
  publisher?: string;
  sha256?: string;
  reason: string;
}

export type ScamPhraseKind = "support_phone_text" | "fake_scan";

export interface ScamPagePhrase {
  phrase: string;
  kind: ScamPhraseKind;
  lang: string;
}

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

export interface DetectionLists {
  /** First 16 hex chars of the sha256 over the canonical (stable key order) JSON of the four lists. */
  version: string;
  remoteAccessTools: readonly RemoteAccessTool[];
  pupPublishers: readonly PupPublisher[];
  scamPagePhrases: readonly ScamPagePhrase[];
  skipDomains: readonly string[];
}

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

/** The four detection lists plus a stable content-hash `version` (16 hex chars). Memoized. */
export function detectionLists(): DetectionLists {
  if (cached) return cached;
  const canonicalJson = JSON.stringify(
    canonicalize({
      remoteAccessTools: REMOTE_ACCESS_TOOLS,
      pupPublishers: PUP_PUBLISHERS,
      scamPagePhrases: SCAM_PAGE_PHRASES,
      skipDomains: SKIP_DOMAINS,
    }),
  );
  const version = createHash("sha256").update(canonicalJson, "utf8").digest("hex").slice(0, 16);
  cached = {
    version,
    remoteAccessTools: REMOTE_ACCESS_TOOLS,
    pupPublishers: PUP_PUBLISHERS,
    scamPagePhrases: SCAM_PAGE_PHRASES,
    skipDomains: SKIP_DOMAINS,
  };
  return cached;
}
