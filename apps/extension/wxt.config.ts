import { defineConfig } from "wxt";

/**
 * The policy public keys (a JSON array of P-256 JWKs, each with a `kid`) baked into this build
 * (`lib/policy/keys.ts`). Unset: the committed default (the production key). Set but not a valid
 * array: the build fails, rather than quietly shipping the default to someone who meant their own.
 */
function policyPubkeysDefine(): string {
  const raw = process.env.NEO_POLICY_PUBKEYS?.trim();
  if (!raw) return JSON.stringify("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NEO_POLICY_PUBKEYS must be a JSON array of P-256 JWKs (each with a kid).");
  }
  const ok =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((k) => k && typeof k === "object" && k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string" && typeof k.kid === "string" && k.kid);
  if (!ok) throw new Error("NEO_POLICY_PUBKEYS must be a JSON array of P-256 JWKs (each with kty, crv, x, y and a kid).");
  return JSON.stringify(raw);
}

/**
 * Neo browser extension (`_specs/browser-extension.md`). MV3 for both Chrome and Firefox.
 * Permissions: `storage`, `alarms`, `downloads`, `contextMenus`, `notifications`, plus the
 * `<all_urls>` host permission for the detection content scripts, plus (Child mode, M2)
 * `declarativeNetRequestWithHostAccess` for SafeSearch and block-page redirects. That permission has
 * no install warning of its own; the broad host access it relies on is already warned about.
 * Nothing else (no `tabs`, `webNavigation`, `webRequest`, `scripting`, `history`, `cookies`,
 * `activeTab`, `unlimitedStorage`: the category lists live in IndexedDB).
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  outDir: ".output",
  vite: () => ({ define: { __NEO_POLICY_PUBKEYS__: policyPubkeysDefine() } }),
  manifest: {
    name: "Neo",
    description: "Neo warns you about scam pages, fake logins and remote-access tricks, and tells your household when it finds one.",
    permissions: ["storage", "alarms", "downloads", "contextMenus", "notifications", "declarativeNetRequestWithHostAccess"],
    host_permissions: ["<all_urls>"],
    // The DNR block-page redirects navigate a web page's tab to the extension's own page, which has to be web-accessible.
    web_accessible_resources: [{ resources: ["blocked.html"], matches: ["<all_urls>"] }],
    browser_specific_settings: {
      gecko: {
        id: "extension@neoshield.dev",
        strict_min_version: "128.0",
        // AMO's data-collection keys as documented at implementation time (extensionworkshop.com,
        // "Firefox add-on data collection"). Re-verify at release: `docs/extension.md` "Verify
        // before submission".
        data_collection_permissions: {
          required: ["browsingActivity"],
        },
      },
    },
  },
  // WXT exposes any `WXT_`-prefixed env var as `import.meta.env.WXT_*` automatically
  // (`envPrefix ??= ["VITE_", "WXT_"]`); `WXT_NEO_BASE_URL` needs no extra config here
  // (`_specs/browser-extension.md` "Server URL", read through `lib/config.ts`).
  zip: {
    // Default kebab-cases the bare package.json "name" ("@neo/extension" -> "neoextension");
    // spelled out here so release assets (`.github/workflows/extension-release.yml`) are legible.
    artifactTemplate: "neo-extension-{{version}}-{{browser}}.zip",
  },
});
