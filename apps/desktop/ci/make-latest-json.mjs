#!/usr/bin/env node
/**
 * Writes the Tauri-format update manifest the service reads (`latest.json`):
 *
 *   node make-latest-json.mjs --version 0.2.0 --url https://.../Neo_0.2.0_x64_en-US.msi \
 *        --sig-file Neo_0.2.0_x64_en-US.msi.sig --out latest.json [--notes "..."] \
 *        [--platform windows-x86_64|darwin-universal] [--merge-into existing-latest.json]
 *
 * `--sig-file` is the `.sig` file written by `tauri signer sign` (it already holds the base64 text
 * the manifest wants). One shared manifest carries every platform: with `--merge-into`, the
 * platforms of an existing manifest of the *same version* are kept and this one's entry is added or
 * replaced (the Windows and macOS release workflows each publish their own entry and whichever runs
 * second merges). A manifest of another version is replaced, so a platform never points at an old build.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
const platform = args.platform ?? "windows-x86_64";
if (!["windows-x86_64", "darwin-universal"].includes(platform)) {
  console.error(`unknown --platform ${platform}`);
  process.exit(2);
}
let platforms = {};
const mergeFrom = args["merge-into"];
if (mergeFrom && existsSync(mergeFrom)) {
  try {
    const existing = JSON.parse(readFileSync(mergeFrom, "utf8"));
    if (existing.version === args.version && existing.platforms && typeof existing.platforms === "object") {
      platforms = existing.platforms;
    }
  } catch {
    // An unreadable existing manifest is replaced.
  }
}
const manifest = {
  version: args.version,
  notes: args.notes ?? "",
  pub_date: new Date().toISOString(),
  platforms: {
    ...platforms,
    [platform]: { url: args.url, signature: readFileSync(args["sig-file"], "utf8").trim() },
  },
};
writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${args.out} for ${args.version} (${Object.keys(manifest.platforms).join(", ")})`);
