/**
 * Browser-safe subpath entry (`@neo/tools/browser`, `_specs/browser-extension.md`): everything
 * the extension's content scripts and background worker need for local detection, with no
 * `node:*` import anywhere in the graph (no `undici`, no `@neo/core` either). Safe for a WXT/Vite
 * browser build; see `packages/tools/test/browser-entry.test.ts` for the import-graph check and
 * the parity tests against the Node entry.
 *
 * The Node entry (`src/index.ts`) re-exports `detectLookalike`, `skeleton` and `normalizeUrl`
 * unchanged: `detectLookalike`/`skeleton` now live in browser-safe modules that `index.ts` also
 * imports, so both entries share one implementation. `normalizeUrl` stays Node-only (it does much
 * more than a browser content script needs: SSRF-guarded redirects, TLS, reputation checks).
 */
export { registrableDomain, type RegistrableDomainInfo } from "./checks/registrable.js";
export { toUnicodeHost } from "./punycode.js";
export { detectLookalike, skeleton } from "./checks/lookalike.js";
export { extractPhoneNumbers, parsePhone, type ParsedPhone } from "./phone.js";
export { normalizeForMatch } from "./text.js";
export { brandId } from "./brands.js";
export type { Brand, Lookalike } from "./types.js";
export type { ListBrand, DetectionListsPayload } from "./listsTypes.js";
