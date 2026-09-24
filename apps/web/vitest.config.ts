import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": here },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // next-auth imports "next/server" without an extension, which Node's ESM
    // resolver rejects; let Vite resolve it instead.
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
  },
});
