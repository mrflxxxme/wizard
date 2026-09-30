// Bundle static files, SPA fallback, /login and the policy page (runtime.yaml#static, #routing.rules,
// #auth.login_page). Files come from the artifact folder written by @wizard/build (system_loading.artifact_layout).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { safeNext } from "../auth/session.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import {
  contentType,
  documentHeaders,
  escapeHtml,
  htmlPage,
  IMMUTABLE,
  NO_CACHE,
} from "../preview/headers.js";

const ASSET_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;
/** Names produced by @wizard/build: index-<sha256[:12]>.{js,css}. */
const HASHED_RE = /-[0-9a-f]{12}\.[a-z0-9]+$/;
/** PWA files arrive in M1 (runtime.yaml#static.pwa). */
const RESERVED_M1 = new Set(["/sw.js", "/manifest.webmanifest"]);

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

function loginPage(c: RuntimeContext): Response {
  const sys = c.get("system");
  const env = c.get("services").env;
  const next = safeNext(c.req.query("next"));
  const wanted = c.req.query("role");
  const roles = sys.spec.roles.filter((r) => r.access === "login" && (!wanted || r.name === wanted));
  let body: string;
  if (sys.entry.env === "draft" && env.devLogin && roles.length > 0) {
    const links = roles.map((r) => {
      const href = `/_wizard/dev-login?role=${encodeURIComponent(r.name)}&next=${encodeURIComponent(next)}`;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(r.label ?? r.name)}</a></li>`;
    });
    body = `<p>Тестовый вход в черновик: выберите роль.</p><ul>${links.join("")}</ul>`;
  } else {
    body = "<p>Вход в систему пока недоступен. Обратитесь к владельцу системы.</p>";
  }
  return c.body(htmlPage("Вход", body), 200, documentHeaders("no-store"));
}

function policyPage(c: RuntimeContext): Response {
  const cmp = c.get("system").spec.compliance;
  const rows: [string, string | undefined][] = [
    ["Оператор", cmp?.operatorName],
    ["Адрес", cmp?.operatorAddress],
    ["ИНН", cmp?.operatorInn],
    ["Контакт для обращений", cmp?.operatorContact],
  ];
  const body = [
    ...rows.filter(([, v]) => v).map(([k, v]) => `<p>${escapeHtml(k)}: ${escapeHtml(String(v))}</p>`),
    cmp?.consentText ? `<h2>Согласие на обработку</h2><p>${escapeHtml(cmp.consentText)}</p>` : "",
  ].join("");
  return c.body(htmlPage("Политика обработки персональных данных", body), 200, documentHeaders());
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
    const policy = sys.spec.compliance?.policyPage;
    if (policy && pathname === policy) return policyPage(c);
    if (RESERVED_M1.has(pathname) || !sys.artifactDir) return notFoundPage();
    if (pathname.startsWith("/assets/")) return serveAsset(c, sys.artifactDir, pathname);
    const index = await readOrNull(join(sys.artifactDir, "client", "index.html"));
    if (!index) return notFoundPage();
    return c.body(new Uint8Array(index), 200, documentHeaders());
  });
  return app;
}
