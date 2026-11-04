import { defineEvalConfig } from "eve/evals";

// Live evals only (NEO_LIVE_EVALS=1, never in CI): see docs/development.md. A small run is about 6 model
// turns on the default routing, a few cents; keep the concurrency low so a rate limit does not look like a failure.
export default defineEvalConfig({ maxConcurrency: 2, timeoutMs: 60_000 });
