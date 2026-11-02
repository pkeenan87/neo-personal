/**
 * Text forms of the Child settings lists, for the member console (_specs/v2-m2-child.md section 3).
 * Pure: the server still validates everything with `PolicyRulesSchema`; these only turn what a person
 * types into the shapes the policy route takes, and back.
 *
 * App line formats (one app per line):
 *   `Signer name | image.exe`   a signer and an image name (Windows)
 *   `image.exe`                 an image name alone
 *   `bundle:com.example.app`    a macOS bundle id
 */
import type { AppRef } from "@neo/verdict";

/** One domain per line (commas and spaces also separate); lowercased, trimmed, deduplicated, blanks dropped. */
export function parseDomainLines(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,;\s]+/)) {
    const d = part.trim().toLowerCase();
    if (d) seen.add(d);
  }
  return [...seen];
}

export function formatDomainLines(domains: readonly string[]): string {
  return domains.join("\n");
}

/** One app per line; a blank line is skipped. Invalid content is passed through for the server to reject with a field path. */
export function parseAppLines(text: string): AppRef[] {
  const out: AppRef[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^bundle:/i.test(line)) {
      out.push({ bundleId: line.slice(line.indexOf(":") + 1).trim() });
    } else if (line.includes("|")) {
      const [signer, ...rest] = line.split("|");
      const image = rest.join("|").trim();
      out.push({ ...(signer!.trim() ? { signer: signer!.trim() } : {}), ...(image ? { image } : {}) });
    } else {
      out.push({ image: line });
    }
  }
  return out;
}

export function formatAppLines(apps: readonly AppRef[]): string {
  return apps
    .map((a) => {
      if ("bundleId" in a) return `bundle:${a.bundleId}`;
      if (a.signer && a.image) return `${a.signer} | ${a.image}`;
      return a.image ?? `${a.signer ?? ""} |`;
    })
    .join("\n");
}

/** The browser's own time zone (an IANA name), or null where the runtime cannot say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
