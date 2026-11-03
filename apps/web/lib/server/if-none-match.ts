/** True when any entry of an `If-None-Match` header (comma-separated, weak `W/"..."` allowed) matches `version`. */
export function ifNoneMatchHits(header: string | null, version: string): boolean {
  if (!header) return false;
  return header.split(",").some((raw) => {
    const tag = raw.trim().replace(/^W\//, "");
    return tag === `"${version}"` || tag === version;
  });
}
