/**
 * Types for the detection lists (`_specs/signals.md`, `_specs/browser-extension.md`), kept in a
 * browser-safe module (no imports besides other type-only files) so `@neo/tools/browser` can
 * export `ListBrand`/`DetectionListsPayload` without pulling in `lists.ts`'s `node:crypto` import.
 */
import type { Brand } from "./types.js";

/**
 * Where a remote session leaves evidence on Windows (`_specs/desktop-agent.md`). `log` paths may use
 * `%ProgramData%`, `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%AppData%`; `pattern` may capture `(?<peer>...)`.
 * Only `verified: true` entries ship to agents; `checked` is "<vendor version> <YYYY-MM-DD>" from the VM task.
 */
export type SessionEvidence =
  | { kind: "log"; path: string; pattern: string; verified: boolean; checked?: string }
  | { kind: "eventlog"; channel: string; eventIds: number[]; verified: boolean; checked?: string }
  | { kind: "process"; name: string; verified: boolean; checked?: string };

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
    /** Session evidence candidates; empty when none is known. */
    sessionEvidence: SessionEvidence[];
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

/** A detection-list brand entry (`_specs/browser-extension.md`): a stable id plus the brand's matching data. */
export type ListBrand = Pick<Brand, "name" | "domains" | "keywords"> & { id: string };

/** The JSON shape of `detectionLists()`, for clients (browser extension, desktop agent). */
export interface DetectionListsPayload {
  /** First 16 hex chars of the sha256 over the canonical (stable key order) JSON of the five lists. */
  version: string;
  remoteAccessTools: readonly RemoteAccessTool[];
  pupPublishers: readonly PupPublisher[];
  scamPagePhrases: readonly ScamPagePhrase[];
  skipDomains: readonly string[];
  brands: readonly ListBrand[];
}
