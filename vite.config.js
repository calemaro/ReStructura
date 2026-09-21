import { defineConfig } from "vite";

// Vite serves src/ during development (instant reload on save, no stale cache)
// and copies it into dist/ for release builds. Tauri points at both: see
// build.devUrl / build.frontendDist in src-tauri/tauri.conf.json.
export default defineConfig({
  root: "src",
  publicDir: "public",              // src/public/* is served at / and copied verbatim
  build: { outDir: "../dist", emptyOutDir: true },
  server: { port: 1420, strictPort: true },
  clearScreen: false,               // keep Tauri's own output visible
});
