/**
 * Server-side environment, read at call time with defaults. Import only from
 * server code (route handlers, server components, auth.ts, lib/session.ts).
 *
 * The root `.env.example` must list every variable read here.
 */
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
  /** Registered sign-in providers (a provider is registered only when configured). */
  AUTH_PROVIDERS: { google: boolean; resend: boolean };
}

/**
 * Connection string for the app role. `NEO_DATABASE_URL` wins over `DATABASE_URL` so a
 * marketplace integration (e.g. Neon on Vercel) can keep managing `DATABASE_URL` with the
 * owner role while the app connects as the least-privilege role that RLS applies to.
 */
export function databaseUrl(source: EnvSource = process.env): string | undefined {
  return nonEmpty(source.NEO_DATABASE_URL) ?? nonEmpty(source.DATABASE_URL);
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
    HAS_ANTHROPIC_CREDENTIALS: Boolean(nonEmpty(source.ANTHROPIC_API_KEY) ?? nonEmpty(source.ANTHROPIC_AUTH_TOKEN)),
    AUTH_PROVIDERS: authProviders(source),
  };
}

/**
 * Which Auth.js providers to register. Both need the database (Auth.js adapter).
 * Google needs AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET. Resend needs AUTH_RESEND_KEY, or
 * MOCK_MODE on a non-deployed environment (the magic link is logged instead of sent).
 */
export function authProviders(source: EnvSource = process.env): { google: boolean; resend: boolean } {
  const database = Boolean(databaseUrl(source));
  const google = database && Boolean(nonEmpty(source.AUTH_GOOGLE_ID) && nonEmpty(source.AUTH_GOOGLE_SECRET));
  const resend =
    database && (Boolean(nonEmpty(source.AUTH_RESEND_KEY)) || (bool(source.MOCK_MODE) && !isDeployedEnvironment(source)));
  return { google, resend };
}

/** Read at call time (not module load) so tests and route handlers see current values. */
export function env(): WebEnv {
  return readEnv(process.env);
}
