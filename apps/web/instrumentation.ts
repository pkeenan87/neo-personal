/**
 * Startup checks (runs once per server process, not during `next build`).
 *  - Production needs AUTH_SECRET: fail fast instead of erroring on the first sign-in.
 *  - DEV_AUTH_BYPASS on a production/preview deployment is ignored; say so loudly.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { devAuthBypassRefused } = await import("./lib/env");
  const { logger } = await import("@neo/core");
  if (devAuthBypassRefused()) {
    logger.error("DEV_AUTH_BYPASS is set on a production/preview deployment and is ignored", "startup");
  }
  if (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET?.trim()) {
    throw new Error("AUTH_SECRET is required in production. Generate one with: openssl rand -base64 32");
  }
}
