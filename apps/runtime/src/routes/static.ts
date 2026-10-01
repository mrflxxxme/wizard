// Bundle static files, SPA fallback, /login and the policy page (runtime.yaml#static, #routing.rules,
// #auth.login_page). Files come from the artifact folder written by @wizard/build (system_loading.artifact_layout).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { withAbuseLink } from "../http/abuse-link.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { contentType, documentHeaders, IMMUTABLE, NO_CACHE } from "../preview/headers.js";
import { injectPwa, serviceWorker, webManifest } from "../pwa/pwa.js";
import { loginPage } from "./login.js";
import { policyPage } from "./privacy.js";

const ASSET_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;
/** Names produced by @wizard/build: index-<sha256[:12]>.{js,css}. */
const HASHED_RE = /-[0-9a-f]{12}\.[a-z0-9]+$/;

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function assetName(pathname: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice("/assets/".length));
  } catch {
    return null;
  }
  return ASSET_RE.test(name) && name !== "." && name !== ".." ? name : null;
}

async function serveAsset(c: RuntimeContext, dir: string, pathname: string): Promise<Response> {
  const name = assetName(pathname);
  const body = name ? await readOrNull(join(dir, "client", "assets", name)) : null;
  if (!name || !body) return notFoundPage();
  return c.body(new Uint8Array(body), 200, {
    "Content-Type": contentType(name),
    "Cache-Control": HASHED_RE.test(name) ? IMMUTABLE : NO_CACHE,
  });
}

export function staticRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.all("*", async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.body(null, 405, { Allow: "GET, HEAD" });
    }
    const sys = c.get("system");
    const pathname = new URL(c.req.url).pathname;
    if (pathname === "/login") return loginPage(c);
    const policy = sys.compliance.policyPage;
    if (policy && pathname === policy) return policyPage(c);
    if (!sys.artifactDir) return notFoundPage();
    // runtime.yaml#static.pwa: generated per system and revision.
    if (pathname === "/sw.js") {
      return c.body(await serviceWorker(sys), 200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": NO_CACHE,
      });
    }
    if (pathname === "/manifest.webmanifest") {
      return c.body(JSON.stringify(await webManifest(sys)), 200, {
        "Content-Type": contentType(pathname),
        "Cache-Control": NO_CACHE,
      });
    }
    if (pathname.startsWith("/assets/")) return serveAsset(c, sys.artifactDir, pathname);
    const index = await readOrNull(join(sys.artifactDir, "client", "index.html"));
    if (!index) return notFoundPage();
    return c.body(withAbuseLink(c, injectPwa(index.toString("utf8"), sys.spec)), 200, documentHeaders());
  });
  return app;
}
