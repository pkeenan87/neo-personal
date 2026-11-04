#!/usr/bin/env node
/**
 * Builds the category lists from scripts/category-lists/.cache/ (see fetch.mjs) and writes:
 *   apps/web/public/category-lists/<version>/<file>.bin, manifest.json, LICENSE-UT1.txt
 *   apps/web/lib/data/category-lists.json   (the pointer GET /api/signals/lists serves)
 * Output is committed; nothing in the app build needs the network.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "./assemble.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const config = JSON.parse(readFileSync(join(here, "sources.json"), "utf8"));
const cacheDir = join(here, ".cache");

function readInput(key) {
  if (key === "local/self-harm") return readFileSync(join(here, "self-harm.txt"), "utf8");
  const path = join(cacheDir, key.replace("/", "__") + ".txt");
  if (!existsSync(path)) throw new Error(`${path} is missing; run scripts/category-lists/fetch.mjs first`);
  return readFileSync(path, "utf8");
}

const { version, files, manifest } = assemble(config, readInput);

const publicRoot = join(root, "apps", "web", "public", "category-lists");
const outDir = join(publicRoot, version);
mkdirSync(publicRoot, { recursive: true });
// Older versions are replaced: clients keep the copy they already downloaded.
for (const entry of readdirSync(publicRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== version) rmSync(join(publicRoot, entry.name), { recursive: true, force: true });
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const [name, bytes] of files) writeFileSync(join(outDir, name), bytes);
copyFileSync(join(here, "LICENSE-UT1.txt"), join(outDir, "LICENSE-UT1.txt"));
const fullManifest = {
  ...manifest,
  hash: "first 4 bytes of SHA-256(domain), big-endian, unique and ascending, stored little-endian (4 bytes per domain)",
  sources: Object.fromEntries(Object.entries(config.sources).map(([k, s]) => [k, { name: s.name, repo: s.repo, commit: s.commit, licence: s.licence }])),
};
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(fullManifest, null, 2)}\n`);

// The pointer the lists route imports (public/ is not part of a serverless function bundle).
const slim = Object.fromEntries(Object.entries(manifest.categories).map(([c, v]) => [c, { file: v.file, sha256: v.sha256, count: v.count }]));
writeFileSync(join(root, "apps", "web", "lib", "data", "category-lists.json"), `${JSON.stringify({ version, path: `/category-lists/${version}/`, categories: slim }, null, 2)}\n`);

let total = 0;
for (const [name, bytes] of files) {
  total += bytes.length;
  console.log(`${name}\t${bytes.length / 4} domains\t${bytes.length} bytes`);
}
console.log(`version ${version}: ${total} bytes in ${files.size} files -> ${outDir}`);
