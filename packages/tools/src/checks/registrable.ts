import { parse as parseDomain } from "tldts";

/**
 * Browser-safe registrable-domain lookup: `tldts` only, no `node:net`/`node:url`. Shared by the
 * Node lookalike check and `@neo/tools/browser` (see `_specs/browser-extension.md`).
 */

export interface RegistrableDomainInfo {
  registrable: string;
  subdomain: string;
  isIp: boolean;
}

/**
 * Full parse detail, for callers (the lookalike check) that need the label separately from the
 * public suffix. `label` is the registrable domain's leftmost part, e.g. `"amazon"` for
 * `amazon.co.uk`; `publicSuffix` is the rest, e.g. `"co.uk"`.
 */
export interface ParsedHost {
  registrable: string;
  subdomain: string;
  publicSuffix: string;
  label: string;
  isIp: boolean;
}

/** Strip a trailing dot and `[...]` IPv6 brackets, and lowercase (defensive; callers usually already do this). */
function bareHost(hostInput: string): string {
  return hostInput.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

/** Full `tldts` parse of a host, or null when it has no recognizable registrable domain. */
export function parseHost(hostInput: string): ParsedHost | null {
  const host = bareHost(hostInput);
  if (!host) return null;
  const p = parseDomain(host, { allowPrivateDomains: false });
  if (p.isIp) return { registrable: host, subdomain: "", publicSuffix: "", label: "", isIp: true };
  if (!p.domain || !p.publicSuffix) return null;
  return {
    registrable: p.domain,
    subdomain: p.subdomain ?? "",
    publicSuffix: p.publicSuffix,
    label: p.domainWithoutSuffix ?? "",
    isIp: false,
  };
}

/**
 * Registrable domain (eTLD+1) and subdomain of a host. Expects a lowercase, punycode-encoded
 * host (as from `location.hostname` or a URL's `.hostname`). Returns null for a host with no
 * recognizable registrable domain.
 */
export function registrableDomain(hostInput: string): RegistrableDomainInfo | null {
  const parsed = parseHost(hostInput);
  if (!parsed) return null;
  return { registrable: parsed.registrable, subdomain: parsed.subdomain, isIp: parsed.isIp };
}
