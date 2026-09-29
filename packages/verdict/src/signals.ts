import { z } from "zod";

/** `SignalEvent.type`, fixed per detector (see `_specs/signals.md`, Events table). */
export const SIGNAL_TYPES = ["page", "software", "remote_session", "permission"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/** `SignalEvent.detector`, the discriminant of `SignalEventSchema`. */
export const SIGNAL_DETECTORS = [
  "tech_support_scam",
  "lookalike_login",
  "dangerous_site",
  "remote_tool_download",
  "warning_bypassed",
  "remote_access_tool",
  "unwanted_software",
  "remote_access_session",
  "tcc_grant",
] as const;
export type SignalDetector = (typeof SIGNAL_DETECTORS)[number];

/** Indicator codes for `page`/`tech_support_scam`. */
export const TECH_SUPPORT_INDICATORS = [
  "fullscreen",
  "pointer_lock",
  "keyboard_lock",
  "looping_audio",
  "back_trap",
  "unload_trap",
  "support_phone_text",
  "fake_scan",
] as const;
export type TechSupportIndicator = (typeof TECH_SUPPORT_INDICATORS)[number];

/** Indicator codes for `page`/`lookalike_login`. */
export const LOOKALIKE_INDICATORS = ["password_field", "punycode", "lookalike_skeleton", "brand_in_subdomain", "new_tab_from_email"] as const;
export type LookalikeIndicator = (typeof LOOKALIKE_INDICATORS)[number];

const UNWANTED_SOFTWARE_REASONS = ["publisher_list", "hash_list", "unsigned_unknown"] as const;
export type UnwantedSoftwareReason = (typeof UNWANTED_SOFTWARE_REASONS)[number];

const REMOTE_SESSION_DIRECTIONS = ["incoming", "outgoing"] as const;
export type RemoteSessionDirection = (typeof REMOTE_SESSION_DIRECTIONS)[number];

const TCC_SERVICES = ["screen_recording", "accessibility", "full_disk_access"] as const;
export type TccService = (typeof TCC_SERVICES)[number];

/** Maximum events accepted in one `POST /api/signals` batch. */
export const MAX_SIGNAL_BATCH = 50;

// ---- Field schemas -----------------------------------------------------
//
// These check shape only (see docs/contracts.md): the server separately
// re-normalizes `domain` with `normalizeUrl` and checks it is registrable,
// checks `observedAt` freshness, and checks `toolId` against the current
// remote-access list.

const IdSchema = z.uuid();
const RelatesToSchema = z.uuid();

/** ISO datetime, offset or `Z` required (a bare local time is rejected). */
const ObservedAtSchema = z.iso.datetime({ offset: true });

/**
 * Registrable domain or IPv4 literal: lowercase host characters only
 * (`[a-z0-9.-]`, which also covers punycode `xn--` labels), 1-253 chars.
 * No `/ ? # : @`, no uppercase, no whitespace.
 */
const DomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, "domain must be lowercase host characters only (no path, query, port or userinfo)");

/** E.164 phone number. */
const PhoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/, "must be E.164");

/** Trimmed, bounded free text shared by `name`, `publisher`, `version` and `app`. */
const BoundedTextSchema = z.string().trim().min(1).max(128);

/** Basename only: same bounds as `BoundedTextSchema`, but never a path. */
const FileNameSchema = BoundedTextSchema.refine((v) => !v.includes("/") && !v.includes("\\"), {
  message: "must be a filename, not a path",
});

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

const PeerIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9 _.@-]+$/, "invalid peer id");

/** Reverse-DNS-ish app bundle id, e.g. `com.anydesk.anydesk`. */
const BundleIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9]+(\.[A-Za-z0-9-]+)+$/, "must look like a reverse-DNS bundle id");

/** A remote-access tool id from the detection list, or a brand id, e.g. `anydesk`, `paypal`. */
const ToolIdSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/, "invalid tool id");
const BrandSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/, "invalid brand id");

/** No duplicate entries (order-insensitive). Rejected rather than silently deduplicated. */
function noDuplicates(arr: readonly string[]): boolean {
  return new Set(arr).size === arr.length;
}

function indicatorsSchema<T extends readonly [string, ...string[]]>(codes: T) {
  return z
    .array(z.enum(codes))
    .min(1)
    .refine(noDuplicates, { message: "duplicate indicator codes" });
}

// ---- Event variants (one per detector) ---------------------------------

const TechSupportScamEvent = z
  .object({
    id: IdSchema,
    type: z.literal("page"),
    detector: z.literal("tech_support_scam"),
    observedAt: ObservedAtSchema,
    domain: DomainSchema,
    indicators: indicatorsSchema(TECH_SUPPORT_INDICATORS),
    phone: PhoneSchema.optional(),
  })
  .strict();

const LookalikeLoginEvent = z
  .object({
    id: IdSchema,
    type: z.literal("page"),
    detector: z.literal("lookalike_login"),
    observedAt: ObservedAtSchema,
    domain: DomainSchema,
    brand: BrandSchema,
    indicators: indicatorsSchema(LOOKALIKE_INDICATORS),
  })
  .strict();

const DangerousSiteEvent = z
  .object({
    id: IdSchema,
    type: z.literal("page"),
    detector: z.literal("dangerous_site"),
    observedAt: ObservedAtSchema,
    domain: DomainSchema,
    source: z.literal("safe_browsing_prefix"),
  })
  .strict();

const RemoteToolDownloadEvent = z
  .object({
    id: IdSchema,
    type: z.literal("page"),
    detector: z.literal("remote_tool_download"),
    observedAt: ObservedAtSchema,
    domain: DomainSchema,
    toolId: ToolIdSchema,
    fileName: FileNameSchema,
  })
  .strict();

const WarningBypassedEvent = z
  .object({
    id: IdSchema,
    type: z.literal("page"),
    detector: z.literal("warning_bypassed"),
    observedAt: ObservedAtSchema,
    relatesTo: RelatesToSchema,
    domain: DomainSchema,
  })
  .strict();

const RemoteAccessToolEvent = z
  .object({
    id: IdSchema,
    type: z.literal("software"),
    detector: z.literal("remote_access_tool"),
    observedAt: ObservedAtSchema,
    toolId: ToolIdSchema,
    name: BoundedTextSchema,
    publisher: BoundedTextSchema.optional(),
    version: BoundedTextSchema.optional(),
  })
  .strict();

const UnwantedSoftwareEvent = z
  .object({
    id: IdSchema,
    type: z.literal("software"),
    detector: z.literal("unwanted_software"),
    observedAt: ObservedAtSchema,
    name: BoundedTextSchema,
    publisher: BoundedTextSchema.optional(),
    version: BoundedTextSchema.optional(),
    sha256: Sha256Schema.optional(),
    reason: z.enum(UNWANTED_SOFTWARE_REASONS),
  })
  .strict();

const RemoteAccessSessionEvent = z
  .object({
    id: IdSchema,
    type: z.literal("remote_session"),
    detector: z.literal("remote_access_session"),
    observedAt: ObservedAtSchema,
    toolId: ToolIdSchema,
    direction: z.enum(REMOTE_SESSION_DIRECTIONS),
    peerId: PeerIdSchema.optional(),
  })
  .strict();

const TccGrantEvent = z
  .object({
    id: IdSchema,
    type: z.literal("permission"),
    detector: z.literal("tcc_grant"),
    observedAt: ObservedAtSchema,
    app: BoundedTextSchema,
    bundleId: BundleIdSchema.optional(),
    service: z.enum(TCC_SERVICES),
  })
  .strict();

/**
 * Discriminated union on `detector`. Every variant is `.strict()`: unknown
 * keys are rejected. This is the single source of truth for the client and
 * server shape of a signal event; the server layers freshness, registrable-
 * domain and known-`toolId` checks on top (see docs/contracts.md).
 */
export const SignalEventSchema = z.discriminatedUnion("detector", [
  TechSupportScamEvent,
  LookalikeLoginEvent,
  DangerousSiteEvent,
  RemoteToolDownloadEvent,
  WarningBypassedEvent,
  RemoteAccessToolEvent,
  UnwantedSoftwareEvent,
  RemoteAccessSessionEvent,
  TccGrantEvent,
]);

export type SignalEvent = z.infer<typeof SignalEventSchema>;

export type ParseSignalEventResult = { ok: true; event: SignalEvent } | { ok: false; id: string | null; reason: "invalid" };

/**
 * Parses one raw signal event. On failure, still extracts `id` when the raw
 * value has a syntactically valid uuid `id` field, so the caller can report
 * a per-event rejection result even for a malformed event.
 */
export function parseSignalEvent(raw: unknown): ParseSignalEventResult {
  const result = SignalEventSchema.safeParse(raw);
  if (result.success) return { ok: true, event: result.data };

  let id: string | null = null;
  if (raw !== null && typeof raw === "object" && "id" in raw) {
    const candidate = (raw as { id?: unknown }).id;
    if (typeof candidate === "string" && IdSchema.safeParse(candidate).success) id = candidate;
  }
  return { ok: false, id, reason: "invalid" };
}
