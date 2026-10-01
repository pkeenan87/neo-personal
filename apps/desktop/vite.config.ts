import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri loads the built files from `dist` (see src-tauri/tauri.conf.json); nothing here needs Rust.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
