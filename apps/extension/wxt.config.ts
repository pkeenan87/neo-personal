import { defineConfig } from "wxt";

/**
 * Neo browser extension (`_specs/browser-extension.md`). MV3 for both Chrome and Firefox.
 * Permissions are exactly the spec's table: `storage`, `alarms`, `downloads`, `contextMenus`,
 * `notifications`, plus the `<all_urls>` host permission for the detection content scripts.
 * Nothing else (no `tabs`, `webNavigation`, `webRequest`, `scripting`, `history`, `cookies`,
 * `activeTab`).
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  outDir: ".output",
  manifest: {
    name: "Neo",
    description: "Neo warns you about scam pages, fake logins and remote-access tricks, and tells your household when it finds one.",
    permissions: ["storage", "alarms", "downloads", "contextMenus", "notifications"],
    host_permissions: ["<all_urls>"],
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
