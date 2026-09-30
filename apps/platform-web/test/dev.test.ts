// `pnpm dev` of platform-web: $PORT/$HOST (docs/reviews/impl-notes/M0-27.md), CSP header (L3-17), Russian page.

import { createServer, type ViteDevServer } from "vite";
import { afterEach, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { platformCsp, systemsFrameSrc } from "../src/csp.js";
import { platformViteConfig } from "../vite.config.js";

let server: ViteDevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

test("dev script is vite; PORT/HOST from the environment", () => {
  expect(pkg.scripts.dev).toBe("vite");
  const env = { ...process.env };
  process.env.PORT = "5999";
  process.env.HOST = "127.0.0.1";
  try {
    const c = platformViteConfig();
    expect(c.server).toMatchObject({ port: 5999, host: "127.0.0.1", strictPort: true });
    expect(c.server?.proxy).toHaveProperty("/api");
  } finally {
    process.env = env;
  }
});

test("CSP: default-src self, no inline scripts, frame-src = systems origin", () => {
  expect(platformCsp({ frameSrc: systemsFrameSrc(undefined) })).toBe(
    "default-src 'self'; script-src 'self'; frame-src http://*.localhost:4100; object-src 'none'; base-uri 'none'",
  );
  expect(systemsFrameSrc("localhost")).toEqual(["http://*.localhost:4100"]);
  expect(systemsFrameSrc("wizard-apps.ru")).toEqual(["https://*.wizard-apps.ru"]);
  expect(platformCsp({ frameSrc: ["http://*.localhost:4100"], dev: true })).toContain(
    "style-src 'self' 'unsafe-inline'",
  );
});

test("dev server answers / with the Russian page and the CSP header", async () => {
  server = await createServer({
    configFile: false,
    ...platformViteConfig({ port: 0 }),
    server: { ...platformViteConfig().server, port: 0, strictPort: false },
  });
  await server.listen();
  const addr = server.httpServer?.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("frame-src http://*.localhost:4100");
  const html = await res.text();
  expect(html).toContain('<html lang="ru">');
  expect(html).toContain("/src/main.tsx");
});
