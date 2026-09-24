/**
 * Server-side environment, read once with defaults. Import only from
 * server code (route handlers, server components, lib/session.ts).
 *
 * The root `.env.example` (owned by the repo, not this app) must list
 * every variable read here.
 */
import pkg from "../package.json";

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

function int(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface WebEnv {
  /** `true` → /api/agent streams a scripted mock conversation instead of calling Claude. */
  MOCK_MODE: boolean;
  /** `true` → getSession() returns a fixed dev user. Ignored when VERCEL_ENV=production. */
  DEV_AUTH_BYPASS: boolean;
  /** Identity of the dev-bypass user. */
  DEV_USER_EMAIL: string;
  DEV_USER_NAME: string;
  /** Per-event delay for the mock stream so the UI visibly streams. */
  MOCK_STREAM_DELAY_MS: number;
  /** Vercel deployment environment: "production" | "preview" | "development" | undefined. */
  VERCEL_ENV: string | undefined;
  /** App version reported by /api/health. Defaults to package.json version. */
  APP_VERSION: string;
  /** Git commit reported by /api/health when running on Vercel. */
  GIT_SHA: string | undefined;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  const vercelEnv = source.VERCEL_ENV || undefined;
  return {
    MOCK_MODE: bool(source.MOCK_MODE),
    // Defense in depth: never honour the auth bypass on a production deployment.
    DEV_AUTH_BYPASS: bool(source.DEV_AUTH_BYPASS) && vercelEnv !== "production",
    DEV_USER_EMAIL: source.DEV_USER_EMAIL || "dev@neo.local",
    DEV_USER_NAME: source.DEV_USER_NAME || "Dev User",
    MOCK_STREAM_DELAY_MS: int(source.MOCK_STREAM_DELAY_MS, 35),
    VERCEL_ENV: vercelEnv,
    APP_VERSION: source.APP_VERSION || pkg.version,
    GIT_SHA: source.VERCEL_GIT_COMMIT_SHA || undefined,
  };
}

/** Read at call time (not module load) so tests and route handlers see current values. */
export function env(): WebEnv {
  return readEnv(process.env);
}
