#!/usr/bin/env node
/**
 * Downloads the pinned category-list sources into scripts/category-lists/.cache/ (git-ignored).
 * Run by hand when updating the lists; the app build never touches the network.
 *
 *   node scripts/category-lists/fetch.mjs                    # download and verify against sources.json
 *   node scripts/category-lists/fetch.mjs --print-checksums  # also print the sha256 of each file (for a new pin)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "sources.json"), "utf8"));
const cacheDir = join(here, ".cache");
const printOnly = process.argv.includes("--print-checksums");

mkdirSync(cacheDir, { recursive: true });
let failed = false;
for (const [key, file] of Object.entries(config.files)) {
  const url = config.sources[file.source].rawBase + file.path;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`${key}: ${url} -> HTTP ${res.status}`);
    failed = true;
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (printOnly) console.log(`${key}\t${sum}`);
  if (file.sha256 && file.sha256 !== sum) {
    console.error(`${key}: sha256 mismatch (expected ${file.sha256}, got ${sum}); refusing to use it`);
    failed = true;
    continue;
  }
  if (!file.sha256) console.warn(`${key}: no sha256 pinned in sources.json (got ${sum})`);
  writeFileSync(join(cacheDir, key.replace("/", "__") + ".txt"), bytes);
  console.log(`${key}: ${bytes.length} bytes`);
}
if (failed) process.exit(1);
