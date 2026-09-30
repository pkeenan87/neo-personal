#!/usr/bin/env node
/**
 * Writes a snapshot of `detectionLists()` into the package as a first-run and offline fallback
 * (`_specs/browser-extension.md` "Background" / "Possible Edge Cases": "The skip list is stale on
 * first run. The bundled snapshot is used until the first fetch."). Runs in Node against the
 * `@neo/tools` root entry (not `/browser`) — that is fine here, since this script never ships in
 * the extension bundle; only its JSON output does (`lib/listsSnapshot.ts`).
 *
 * Run before `wxt build`/`wxt zip` (see `package.json`); the output is committed like the other
 * `@neo/tools` list data, and regenerated here so it never drifts from the shipped lists.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectionLists } from "@neo/tools";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "lib", "data", "lists-snapshot.json");

const lists = detectionLists();
writeFileSync(outPath, `${JSON.stringify(lists, null, 2)}\n`);
console.log(`Wrote ${outPath} (version ${lists.version})`);
