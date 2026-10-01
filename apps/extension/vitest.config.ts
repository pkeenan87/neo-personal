import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  // `WxtVitest()` (async) wires the `wxt/browser` -> `fakeBrowser` alias, auto-imports and
  // tsconfig paths; Vite accepts a promise-of-plugins entry directly in `plugins`.
  plugins: [WxtVitest()],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
  },
});
