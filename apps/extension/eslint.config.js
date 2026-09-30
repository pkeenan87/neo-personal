import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", ".output/**", ".wxt/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    rules: {
      // Content scripts and the background monkey-patch browser APIs at the MAIN-world hook
      // boundary (wrapped page APIs, CustomEvent detail payloads): `any` there is the honest type.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Plain Node ESM build scripts (not part of the extension bundle).
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
);
