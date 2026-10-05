// GET /_wizard/fonts/:file (runtime.yaml#service_endpoints.fonts, ui-kit.yaml#tokens.fonts, M2-42): theme fonts from the
// ui-kit catalog, served from the system's own origin (CSP font-src 'self'; no Google Fonts or other CDNs, 152-ФЗ).
// Only catalog file names are served; names carry a content hash, so the response is immutable.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fontFiles } from "@wizard/ui-kit/fonts";
import { Hono } from "hono";
import type { RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { IMMUTABLE } from "../preview/headers.js";

/** packages/ui-kit/fonts (next to src/tokens/fonts.ts of the package). */
export const FONTS_DIR = join(
  dirname(createRequire(import.meta.url).resolve("@wizard/ui-kit/fonts")),
  "../../fonts",
);
const ALLOWED = new Set(fontFiles());
const cache = new Map<string, Uint8Array>();

async function load(file: string): Promise<Uint8Array | null> {
  const hit = cache.get(file);
  if (hit) return hit;
  try {
    const data = new Uint8Array(await readFile(join(FONTS_DIR, file)));
    cache.set(file, data);
    return data;
  } catch {
    return null;
  }
}

export function fontsRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.get("/:file", async (c) => {
    const file = c.req.param("file");
    const data = ALLOWED.has(file) ? await load(file) : null;
    if (!data) return notFoundPage();
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "font/woff2",
      "Content-Length": String(data.byteLength),
      "Cache-Control": IMMUTABLE,
    });
  });
  return app;
}
