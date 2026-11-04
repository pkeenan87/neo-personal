/**
 * Assembles the category `.bin` files and manifest from already-read source texts (no I/O), so the
 * unit tests can run it on small fixtures. build.mjs does the reading and writing.
 */
import { encodeBin, parseList, prefixesFor, sha256Hex } from "./normalize.mjs";

const GENERATED_LICENCE = {
  ut1: "CC BY-SA 4.0",
  blp: "Unlicense",
  local: "MIT",
};

/**
 * @param {{ sources: Record<string, {name:string, repo:string, commit:string, licence:string}>, files: Record<string,{source:string}>, categories: Record<string,{inputs:string[]}> }} config
 * @param {(inputKey: string) => string} readInput source text for a key like "blp/porn" or "local/self-harm"
 * @returns {{ version: string, files: Map<string, Buffer>, manifest: object }}
 */
export function assemble(config, readInput) {
  const files = new Map();
  const categories = {};
  for (const [category, def] of Object.entries(config.categories)) {
    const domains = new Set();
    const usedSources = new Set();
    for (const input of def.inputs) {
      usedSources.add(input.startsWith("local/") ? "local" : config.files[input].source);
      for (const d of parseList(readInput(input))) domains.add(d);
    }
    const prefixes = prefixesFor(domains);
    const bin = encodeBin(prefixes);
    // Any UT1 input makes the whole file a UT1 derivative (CC BY-SA), whatever else was folded in.
    const derivesFromUt1 = usedSources.has("ut1");
    const file = `${derivesFromUt1 ? "ut1-" : ""}${category}.bin`;
    files.set(file, bin);
    const sourceNames = [...usedSources].map((s) => (s === "local" ? "Neo hand-curated list" : `${config.sources[s].name} @ ${config.sources[s].commit}`));
    categories[category] = {
      file,
      count: prefixes.length,
      sha256: sha256Hex(bin),
      source: sourceNames.join(" + "),
      licence: derivesFromUt1 ? GENERATED_LICENCE.ut1 : usedSources.has("blp") ? config.sources.blp.licence : GENERATED_LICENCE.local,
    };
  }
  // Content-addressed: the same inputs always give the same version.
  const version = `c${sha256Hex(JSON.stringify(Object.entries(categories).map(([c, v]) => [c, v.file, v.sha256, v.count]))).slice(0, 12)}`;
  return { version, files, manifest: { version, categories } };
}
