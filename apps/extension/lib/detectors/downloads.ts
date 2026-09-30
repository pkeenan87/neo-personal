/**
 * Remote-access-tool download detector (`_specs/browser-extension.md` "Detectors",
 * `page`/`remote_tool_download`). Pure matching against the detection lists; the content script's
 * only job is calling `matchDownload` from `downloads.onCreated` and, on a match, sending the
 * event and showing the notification (never cancelling or pausing the download).
 */
import { registrableDomain } from "@neo/tools/browser";
import type { DetectionListsPayload } from "@neo/tools/browser";

export type RemoteAccessTool = DetectionListsPayload["remoteAccessTools"][number];

export interface DownloadInput {
  /** `downloads.DownloadItem.filename` (may be an absolute local path) or, absent that, the URL. */
  filename?: string;
  url: string;
  referrer?: string;
}

export interface DownloadMatch {
  toolId: string;
  toolName: string;
  /** Basename only, at most 128 characters (`FileNameSchema`, `@neo/verdict`). */
  fileName: string;
  domain: string;
}

/** Basename of a filesystem path or URL path, forward- or back-slash separated. */
export function basename(pathOrUrl: string): string {
  let path = pathOrUrl;
  try {
    path = new URL(pathOrUrl).pathname;
  } catch {
    // Not a URL: treat the whole string as a path (a local download path, e.g. on Windows).
  }
  const parts = path.split(/[\\/]/).filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] ?? "");
}

/** Compiles installer-pattern regex sources case-insensitively; an invalid source is skipped. */
function compilePatterns(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, "i"));
    } catch {
      // A bad pattern in a server-supplied list must not break detection.
    }
  }
  return out;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Matches a completed-download event against the remote-access-tools list. Returns `null` when
 * nothing matches, or when it matches a tool but the referring (or download) domain is one of that
 * tool's own `vendorDomains` (the legitimate download is not reported).
 */
export function matchDownload(download: DownloadInput, tools: readonly RemoteAccessTool[]): DownloadMatch | null {
  // Truncated *before* matching, not after: `_specs/browser-extension.md` "Background" requires
  // server-supplied patterns to only ever run on a filename of at most 128 characters (a bound on
  // a hostile or accidentally-catastrophic pattern's cost). An unusually long name that would
  // otherwise match past that point is simply not detected — the truncation is the safety limit.
  const rawName = basename(download.filename || download.url).slice(0, 128);
  if (!rawName) return null;

  const domainSource = download.referrer || download.url;
  const host = hostnameOf(domainSource);
  if (!host) return null;
  const domainInfo = registrableDomain(host);
  if (!domainInfo || domainInfo.isIp) return null;

  for (const tool of tools) {
    const patterns = compilePatterns(tool.installerPatterns);
    if (!patterns.some((re) => re.test(rawName))) continue;
    if (tool.vendorDomains.includes(domainInfo.registrable)) return null;
    return { toolId: tool.id, toolName: tool.name, fileName: rawName, domain: domainInfo.registrable };
  }
  return null;
}
