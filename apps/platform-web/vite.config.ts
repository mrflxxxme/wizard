// Vite for apps/platform-web: $PORT/$HOST (scripts/dev.mjs, deploy.yaml#local.ports), /api → platform-api :4000,
// CSP headers of platform-screens.yaml#stack on dev and preview servers.
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ProxyOptions, type UserConfig } from "vite";
import { platformCsp, systemsFrameSrc } from "./src/csp.js";

export const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));

export interface PlatformViteOptions {
  apiTarget?: string;
  frameSrc?: string[];
  port?: number;
  host?: string;
  outDir?: string;
}

function cspPlugin(frameSrc: string[]): Plugin {
  const header = (dev: boolean) => platformCsp({ frameSrc, dev });
  return {
    name: "wizard-csp",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Content-Security-Policy", header(true));
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Content-Security-Policy", header(false));
        next();
      });
    },
  };
}

export function platformViteConfig(o: PlatformViteOptions = {}): UserConfig {
  const port = o.port ?? Number(process.env.PORT ?? 5173);
  const host = o.host ?? process.env.HOST ?? "127.0.0.1";
  const proxy: Record<string, ProxyOptions> = {
    "/api": {
      target: o.apiTarget ?? "http://127.0.0.1:4000",
      changeOrigin: false,
      // A broken upstream (platform-api restart) must break the browser side too, so EventSource reconnects.
      configure: (p) =>
        p.on("proxyRes", (proxyRes, _req, res) => {
          proxyRes.on("close", () => {
            if (!proxyRes.complete) res.destroy();
          });
        }),
    },
  };
  return {
    root: APP_ROOT,
    esbuild: { jsx: "automatic" },
    plugins: [cspPlugin(o.frameSrc ?? systemsFrameSrc(process.env.WIZARD_SYSTEMS_DOMAIN))],
    server: {
      port,
      host,
      strictPort: true,
      proxy,
      fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
    },
    preview: { port, host, strictPort: true, proxy },
    build: { outDir: o.outDir ?? "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
    logLevel: "warn",
  };
}

export default defineConfig(platformViteConfig());
