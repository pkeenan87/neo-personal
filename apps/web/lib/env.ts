/**
 * Server-side environment, read at call time with defaults. Import only from
 * server code (route handlers, server components, auth.ts, lib/session.ts).
 *
 * The root `.env.example` must list every variable read here.
 */
import { gatewayEnabled } from "@neo/core";
import pkg from "../package.json";

/** Any env-like map (process.env, or a plain object in tests). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

function int(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * True on a deployment that real users can reach: `NODE_ENV=production`
 * (`next start`, Vercel) or `VERCEL_ENV` of `production` / `preview`.
 */
export function isDeployedEnvironment(source: EnvSource = process.env): boolean {
  const vercelEnv = nonEmpty(source.VERCEL_ENV);
  return source.NODE_ENV === "production" || vercelEnv === "production" || vercelEnv === "preview";
}

/**
 * The DEV_AUTH_BYPASS guard. Active only when the flag is true AND this is not a
 * production or preview deployment (see CLAUDE.md, _specs/tenant-auth.md).
 */
export function devAuthBypassActive(source: EnvSource = process.env): boolean {
  return bool(source.DEV_AUTH_BYPASS) && !isDeployedEnvironment(source);
}

/** True when DEV_AUTH_BYPASS is set but ignored because this is a production/preview deployment. */
export function devAuthBypassRefused(source: EnvSource = process.env): boolean {
  return bool(source.DEV_AUTH_BYPASS) && isDeployedEnvironment(source);
}

export interface WebEnv {
  /** `true` → every external API (Claude, analyzers, email) uses deterministic fixtures. */
  MOCK_MODE: boolean;
  /** Effective dev auth bypass (flag AND not production/preview). */
  DEV_AUTH_BYPASS: boolean;
  /** Identity of the dev-bypass user. */
  DEV_USER_EMAIL: string;
  DEV_USER_NAME: string;
  /** Per-event delay for the MOCK_MODE scripted model so the UI visibly streams. */
  MOCK_STREAM_DELAY_MS: number;
  /** Vercel deployment environment: "production" | "preview" | "development" | undefined. */
  VERCEL_ENV: string | undefined;
  /** App version reported by /api/health. Defaults to package.json version. */
  APP_VERSION: string;
  /** Git commit reported by /api/health when running on Vercel. */
  GIT_SHA: string | undefined;
  /** Postgres connection string (app role): NEO_DATABASE_URL, else DATABASE_URL. Unset → in-memory fallbacks (MOCK_MODE / tests only). */
  DATABASE_URL: string | undefined;
  /** Anthropic credentials are present (MOCK_MODE does not need them). */
  HAS_ANTHROPIC_CREDENTIALS: boolean;
  /** A model is reachable: Anthropic credentials, or AI Gateway (NEO_MODEL_GATEWAY=true + AI_GATEWAY_API_KEY). */
  HAS_MODEL_CREDENTIALS: boolean;
  /** Registered sign-in providers (a provider is registered only when configured). */
  AUTH_PROVIDERS: { google: boolean; resend: boolean };
  // ── Phase 1: intake artifacts (_specs/intake.md) ──
  /** Vercel Blob is reachable: BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID (OIDC store set by the Vercel Blob integration). Unset → in-memory blob client (MOCK_MODE / local only). */
  HAS_BLOB_TOKEN: boolean;
  /** NEO_MASTER_KEY is set (artifact encryption). Validity is checked by masterKeyFromEnv. */
  HAS_MASTER_KEY: boolean;
  /** NEO_ARTIFACT_RETENTION_DAYS, default 30. */
  ARTIFACT_RETENTION_DAYS: number;
  // ── end Phase 1: intake artifacts ──
}

/**
 * Connection string for the app role. `NEO_DATABASE_URL` wins over `DATABASE_URL` so a
 * marketplace integration (e.g. Neon on Vercel) can keep managing `DATABASE_URL` with the
 * owner role while the app connects as the least-privilege role that RLS applies to.
 */
export function databaseUrl(source: EnvSource = process.env): string | undefined {
  return nonEmpty(source.NEO_DATABASE_URL) ?? nonEmpty(source.DATABASE_URL);
}

/**
 * Vercel Blob is usable: an explicit read-write token, or an OIDC-connected store
 * (`BLOB_STORE_ID`, which the Vercel Blob integration sets; the SDK then authenticates
 * with the runtime `VERCEL_OIDC_TOKEN`).
 */
export function hasBlobStore(source: EnvSource = process.env): boolean {
  return Boolean(nonEmpty(source.BLOB_READ_WRITE_TOKEN) ?? nonEmpty(source.BLOB_STORE_ID));
}

/** `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set (direct Anthropic access). */
export function hasAnthropicCredentials(source: EnvSource = process.env): boolean {
  return Boolean(nonEmpty(source.ANTHROPIC_API_KEY) ?? nonEmpty(source.ANTHROPIC_AUTH_TOKEN));
}

/**
 * Some model is reachable: direct Anthropic credentials, or Vercel AI Gateway
 * (`NEO_MODEL_GATEWAY=true` + `AI_GATEWAY_API_KEY`, see `gatewayEnabled` in @neo/core).
 */
export function hasModelCredentials(source: EnvSource = process.env): boolean {
  return hasAnthropicCredentials(source) || gatewayEnabled({ ...source });
}

/**
 * Resend API key: `RESEND_API_KEY`, else `AUTH_RESEND_KEY`, else `MESSAGING_RESEND_API_KEY`
 * (the name the Resend marketplace integration on Vercel sets).
 */
export function resendApiKey(source: EnvSource = process.env): string | undefined {
  return nonEmpty(source.RESEND_API_KEY) ?? nonEmpty(source.AUTH_RESEND_KEY) ?? nonEmpty(source.MESSAGING_RESEND_API_KEY);
}

/**
 * Sender for sign-in and notification emails: `EMAIL_FROM`, else `Neo <neo@…>` on the
 * Resend integration's verified domain (`MESSAGING_RESEND_EMAIL_DOMAIN`), else a placeholder.
 */
export function emailFrom(source: EnvSource = process.env): string {
  const explicit = nonEmpty(source.EMAIL_FROM);
  if (explicit) return explicit;
  const domain = nonEmpty(source.MESSAGING_RESEND_EMAIL_DOMAIN)?.toLowerCase();
  return domain ? `Neo <neo@${domain}>` : "Neo <neo@example.com>";
}

/** Contact address shown on the privacy policy (`NEO_CONTACT_EMAIL`). */
export function contactEmail(source: EnvSource = process.env): string {
  return nonEmpty(source.NEO_CONTACT_EMAIL) ?? "privacy@neoshield.dev";
}

export function readEnv(source: EnvSource = process.env): WebEnv {
  const mock = bool(source.MOCK_MODE);
  const database = databaseUrl(source);
  return {
    MOCK_MODE: mock,
    DEV_AUTH_BYPASS: devAuthBypassActive(source),
    DEV_USER_EMAIL: (nonEmpty(source.DEV_USER_EMAIL) ?? "dev@neo.local").toLowerCase(),
    DEV_USER_NAME: nonEmpty(source.DEV_USER_NAME) ?? "Dev User",
    MOCK_STREAM_DELAY_MS: int(source.MOCK_STREAM_DELAY_MS, 35),
    VERCEL_ENV: nonEmpty(source.VERCEL_ENV),
    APP_VERSION: nonEmpty(source.APP_VERSION) ?? pkg.version,
    GIT_SHA: nonEmpty(source.VERCEL_GIT_COMMIT_SHA),
    DATABASE_URL: database,
    HAS_ANTHROPIC_CREDENTIALS: hasAnthropicCredentials(source),
    HAS_MODEL_CREDENTIALS: hasModelCredentials(source),
    AUTH_PROVIDERS: authProviders(source),
    // ── Phase 1: intake artifacts ──
    HAS_BLOB_TOKEN: hasBlobStore(source),
    HAS_MASTER_KEY: Boolean(nonEmpty(source.NEO_MASTER_KEY)),
    ARTIFACT_RETENTION_DAYS: int(source.NEO_ARTIFACT_RETENTION_DAYS, 30) || 30,
    // ── end Phase 1: intake artifacts ──
  };
}

/**
 * Which Auth.js providers to register. Both need the database (Auth.js adapter).
 * Google needs AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET. Resend needs a key (see resendApiKey), or
 * MOCK_MODE on a non-deployed environment (the magic link is logged instead of sent).
 */
export function authProviders(source: EnvSource = process.env): { google: boolean; resend: boolean } {
  const database = Boolean(databaseUrl(source));
  const google = database && Boolean(nonEmpty(source.AUTH_GOOGLE_ID) && nonEmpty(source.AUTH_GOOGLE_SECRET));
  const resend =
    database && (Boolean(resendApiKey(source)) || (bool(source.MOCK_MODE) && !isDeployedEnvironment(source)));
  return { google, resend };
}

/** Read at call time (not module load) so tests and route handlers see current values. */
export function env(): WebEnv {
  return readEnv(process.env);
}

// ---------------------------------------------------------------------------
// BEGIN forward-to-address (Phase 1, _specs/forward-to-address.md)
// ---------------------------------------------------------------------------

export interface InboundEnv {
  /** Domain the household addresses live on (`check-…@<domain>`). Unset → the feature is unconfigured. */
  NEO_INBOUND_DOMAIN: string | undefined;
  /** Svix signing secret of the Resend `email.received` webhook (`whsec_…`). */
  RESEND_WEBHOOK_SECRET: string | undefined;
  /** Resend API key for fetching received mail and sending notifications (see resendApiKey). */
  RESEND_API_KEY: string | undefined;
  /** Inngest Cloud event key. Unset + MOCK_MODE → the job runs inline from the webhook. */
  INNGEST_EVENT_KEY: string | undefined;
  /** Inngest signing key (verifies calls to /api/inngest). */
  INNGEST_SIGNING_KEY: string | undefined;
  /** Accepted messages per inbound address per hour; the rest are recorded as rejected. Default 30. */
  NEO_INBOUND_RATE_LIMIT_PER_HOUR: number;
  /** Sender of notification emails. */
  EMAIL_FROM: string;
  /** Absolute base URL for links in notification emails (AUTH_URL, else the Vercel production host). */
  APP_URL: string;
}

export function inboundEnv(source: EnvSource = process.env): InboundEnv {
  const vercelHost = nonEmpty(source.VERCEL_PROJECT_PRODUCTION_URL);
  const base = nonEmpty(source.AUTH_URL) ?? (vercelHost ? `https://${vercelHost}` : "http://localhost:3000");
  return {
    NEO_INBOUND_DOMAIN: nonEmpty(source.NEO_INBOUND_DOMAIN)?.toLowerCase(),
    RESEND_WEBHOOK_SECRET: nonEmpty(source.RESEND_WEBHOOK_SECRET),
    RESEND_API_KEY: resendApiKey(source),
    INNGEST_EVENT_KEY: nonEmpty(source.INNGEST_EVENT_KEY),
    INNGEST_SIGNING_KEY: nonEmpty(source.INNGEST_SIGNING_KEY),
    NEO_INBOUND_RATE_LIMIT_PER_HOUR: int(source.NEO_INBOUND_RATE_LIMIT_PER_HOUR, 30),
    EMAIL_FROM: emailFrom(source),
    APP_URL: base.replace(/\/+$/, ""),
  };
}

/** "ok" when everything forward-to-address needs in production is set, else "unconfigured". */
export function inboundStatus(source: EnvSource = process.env): "ok" | "unconfigured" {
  const e = inboundEnv(source);
  const ready =
    e.NEO_INBOUND_DOMAIN && e.RESEND_WEBHOOK_SECRET && e.RESEND_API_KEY && e.INNGEST_EVENT_KEY && e.INNGEST_SIGNING_KEY;
  return ready ? "ok" : "unconfigured";
}

// END forward-to-address

export interface BreachMonitoringEnv {
  HIBP_API_KEY?: string;
  HIBP_RPM: number;
  HIBP_USER_AGENT: string;
}

export const HIBP_RPM_DEFAULT = 10;
export const HIBP_USER_AGENT_DEFAULT = "Neo breach monitoring (https://www.neoshield.dev)";
const HIBP_RPM_MAX = 1000;

/** Server-only HIBP settings. Invalid RPM values fall back to the conservative default. */
export function breachMonitoringEnv(source: EnvSource = process.env): BreachMonitoringEnv {
  const key = nonEmpty(source.HIBP_API_KEY);
  const rawRpm = nonEmpty(source.HIBP_RPM);
  const rpm = rawRpm && /^\d+$/.test(rawRpm) ? Number(rawRpm) : NaN;
  return {
    ...(key ? { HIBP_API_KEY: key } : {}),
    HIBP_RPM: Number.isSafeInteger(rpm) && rpm >= 1 && rpm <= HIBP_RPM_MAX ? rpm : HIBP_RPM_DEFAULT,
    HIBP_USER_AGENT: nonEmpty(source.HIBP_USER_AGENT) ?? HIBP_USER_AGENT_DEFAULT,
  };
}

// ---------------------------------------------------------------------------
// Outlook.com connector (_specs/outlook-connector.md)
// ---------------------------------------------------------------------------

export interface OutlookEnv {
  /** "live": real Microsoft endpoints (all three vars and NEO_MASTER_KEY set). "mock": MOCK_MODE on a non-deployed environment (fake authorize/callback, fixture mailbox). "off": the feature is disabled. */
  mode: "live" | "mock" | "off";
  OUTLOOK_CLIENT_ID: string | undefined;
  OUTLOOK_CLIENT_SECRET: string | undefined;
  OUTLOOK_REDIRECT_URI: string | undefined;
}

/**
 * Connector availability. Unset client id, secret or redirect URI, or a missing NEO_MASTER_KEY (the token
 * ciphertext needs it), turns the feature off; MOCK_MODE (never on a production/preview deployment) uses the
 * fake Microsoft flow and never contacts Microsoft.
 */
export function outlookEnv(source: EnvSource = process.env): OutlookEnv {
  const id = nonEmpty(source.OUTLOOK_CLIENT_ID);
  const secret = nonEmpty(source.OUTLOOK_CLIENT_SECRET);
  const redirect = nonEmpty(source.OUTLOOK_REDIRECT_URI);
  const configured = Boolean(id && secret && redirect && nonEmpty(source.NEO_MASTER_KEY));
  const mode = bool(source.MOCK_MODE) && !isDeployedEnvironment(source) ? "mock" : configured ? "live" : "off";
  return { mode, OUTLOOK_CLIENT_ID: id, OUTLOOK_CLIENT_SECRET: secret, OUTLOOK_REDIRECT_URI: redirect };
}
