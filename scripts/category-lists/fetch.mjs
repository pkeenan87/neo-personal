#!/usr/bin/env node
/**
 * Downloads the pinned category-list sources into scripts/category-lists/.cache/ (git-ignored).
 * Run by hand when updating the lists; the app build never touches the network.
 *
 *   node scripts/category-lists/fetch.mjs                    # download and verify against sources.json
 *   node scripts/category-lists/fetch.mjs --print-checksums  # print each file's sha256 for a new pin (writes nothing)
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
const MAX_BYTES = 64 * 1024 * 1024;
const SAFE_KEY = /^[a-z0-9_-]+\/[a-z0-9_.-]+$/;

/** Only https raw GitHub files at the source's own repo and pinned commit are fetched. */
function pinnedUrl(source, path) {
  const url = new URL(source.rawBase + path);
  const repoPath = new URL(source.repo).pathname.replace(/\/$/, "");
  if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com" || !url.pathname.startsWith(`${repoPath}/${source.commit}/`)) {
    throw new Error(`refusing ${url.href}: not a raw.githubusercontent.com file at ${repoPath} commit ${source.commit}`);
  }
  return url;
}

let failed = false;
for (const [key, file] of Object.entries(config.files)) {
  if (!SAFE_KEY.test(key)) {
    console.error(`${key}: unsafe key in sources.json; refusing`);
    failed = true;
    continue;
  }
  const source = config.sources[file.source];
  let url;
  try {
    url = pinnedUrl(source, file.path);
  } catch (err) {
    console.error(`${key}: ${err.message}`);
    failed = true;
    continue;
  }
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) {
    console.error(`${key}: ${url.href} -> HTTP ${res.status}`);
    failed = true;
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) {
    console.error(`${key}: ${bytes.length} bytes is over the ${MAX_BYTES}-byte limit; refusing`);
    failed = true;
    continue;
  }
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (printOnly) {
    // Pinning mode: report checksums only; nothing unverified is written.
    console.log(`${key}\t${sum}`);
    continue;
  }
  if (file.sha256 !== sum) {
    console.error(`${key}: sha256 ${file.sha256 ? `mismatch (expected ${file.sha256}, got ${sum})` : `not pinned (got ${sum})`}; refusing to use it`);
    failed = true;
    continue;
  }
  // Only bytes matching the pinned sha256 reach the cache.
  writeFileSync(join(cacheDir, key.replace("/", "__") + ".txt"), bytes);
  console.log(`${key}: ${bytes.length} bytes`);
}
if (failed) process.exit(1);
