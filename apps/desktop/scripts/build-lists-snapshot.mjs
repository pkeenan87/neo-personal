#!/usr/bin/env node
/**
 * Writes `detectionLists()` into the service crate as its first-run and offline fallback
 * (`crates/agent-service/data/lists-snapshot.json`, compiled in with `include_str!`). Run it after
 * changing `packages/tools/src/data/**` (`pnpm --filter @neo/desktop lists`); a test in this
 * package fails when the committed copy has drifted.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectionLists } from "@neo/tools";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "crates", "agent-service", "data", "lists-snapshot.json");

const lists = detectionLists();
writeFileSync(outPath, `${JSON.stringify(lists, null, 2)}\n`);
console.log(`Wrote ${outPath} (version ${lists.version})`);
