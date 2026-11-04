/**
 * The hashed category domain lists (_specs/v2-m2-child.md section 5), published as static files under
 * `public/category-lists/<version>/` and described by `lib/data/category-lists.json` (written by
 * `scripts/category-lists/build.mjs`; public/ is not part of a serverless bundle, so the route reads
 * the pointer, not the files).
 */
import type { CategoryListsInfo } from "@neo/tools";
import manifest from "@/lib/data/category-lists.json";

/** Version of the whole lists response: the detection-lists hash, plus the category set when there is one. */
export function combinedListsVersion(detectionVersion: string): string {
  return manifest.version ? `${detectionVersion}-${manifest.version}` : detectionVersion;
}

/** `categoryLists` for the lists response; `origin` is the request's own origin (the files are served next to the API). */
export function categoryListsInfo(origin: string): CategoryListsInfo {
  return { version: manifest.version, baseUrl: `${origin}${manifest.path}`, categories: manifest.categories };
}
