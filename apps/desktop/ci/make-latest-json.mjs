#!/usr/bin/env node
/**
 * Writes the Tauri-format update manifest the service reads (`latest.json`):
 *
 *   node make-latest-json.mjs --version 0.2.0 --url https://.../Neo_0.2.0_x64_en-US.msi \
 *        --sig-file Neo_0.2.0_x64_en-US.msi.sig --out latest.json [--notes "..."]
 *
 * `--sig-file` is the `.sig` file written by `tauri signer sign` (it already holds the base64 text
 * the manifest wants).
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ["version", "url", "sig-file", "out"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}
const manifest = {
  version: args.version,
  notes: args.notes ?? "",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { url: args.url, signature: readFileSync(args["sig-file"], "utf8").trim() },
  },
};
writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${args.out} for ${args.version}`);
