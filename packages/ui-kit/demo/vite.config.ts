import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: { jsx: "automatic" },
  server: { fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  logLevel: "warn",
});
