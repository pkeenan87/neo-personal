import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "crates/**", "target/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    // Plain Node ESM scripts (build helpers and the CI fake server; not part of the UI bundle).
    files: ["scripts/**/*.mjs", "ci/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
);
