import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const FONTS = fileURLToPath(new URL("../fonts/", import.meta.url));

/** /_wizard/fonts/<file> like the runtime does (ui-kit.yaml#tokens.fonts), for the demo dev and preview servers. */
function wizardFonts(): Plugin {
  const serve = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = /^\/_wizard\/fonts\/([A-Za-z0-9.-]+\.woff2)$/.exec(req.url ?? "");
    if (!m) return next();
    try {
      const data = await readFile(`${FONTS}${m[1]}`);
      res.setHeader("Content-Type", "font/woff2");
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  };
  return {
    name: "wizard-fonts",
    configureServer: (s) => void s.middlewares.use((req, res, next) => void serve(req, res, next)),
    configurePreviewServer: (s) => void s.middlewares.use((req, res, next) => void serve(req, res, next)),
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: { jsx: "automatic" },
  plugins: [wizardFonts()],
  server: { fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    // Second page: design system v2 of the platform (B2-32), served at /v2/.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        v2: fileURLToPath(new URL("v2/index.html", import.meta.url)),
      },
    },
  },
  logLevel: "warn",
});
