// M2-08 on the runtime side (security/abuse.yaml#report.entry_points, #takedown, #messages_ru.http_451): every prod
// document carries «Пожаловаться» leading to the platform form with the page URL; drafts do not; a taken-down system
// answers 451 with the neutral Russian page on every path except /_wizard/health.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { abuseFormUrl, injectAbuseLink } from "../src/http/abuse-link.js";
import { createRuntimeApp, FileRegistry, type RegistryEntry, type RuntimeApp } from "../src/index.js";
import { DB_URL, devEnv, forumSpec, newKey, request } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "wz-runtime-abuse-"));
const regPath = join(root, "registry.json");
const key = newKey();
const sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
let rt: RuntimeApp;
const PROD = "shop.localhost:4100";
const DRAFT = "shop--draft.localhost:4100";
const INDEX =
  '<!doctype html><html><head><title>Магазин</title></head><body><div id="root"></div></body></html>';

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    systemId: key,
    slug: "shop",
    env: "prod",
    revision: 1,
    specHash: "h1",
    bundleKey: "b1",
    publishedAt: "2026-10-01T00:00:00Z",
    suspended: false,
    features: { phoneOtp: false },
    ...over,
  };
}

let tick = 0;
function writeRegistry(list: RegistryEntry[]) {
  writeFileSync(regPath, JSON.stringify({ deployments: list }));
  tick += 1;
  const t = new Date(Date.now() + tick * 1000);
  utimesSync(regPath, t, t);
}

beforeAll(() => {
  const dir = join(root, key, "1");
  mkdirSync(join(dir, "client"), { recursive: true });
  writeFileSync(join(dir, "spec.json"), JSON.stringify(forumSpec()));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ specHash: "h1", bundleKey: "b1" }));
  writeFileSync(join(dir, "client", "index.html"), INDEX);
  rt = createRuntimeApp({ db: sql, registry: new FileRegistry(regPath), artifactsRoot: root, env: devEnv });
});

afterAll(async () => {
  await sql.end();
  rmSync(root, { recursive: true, force: true });
});

const linkHref = (html: string) =>
  /href="([^"]+)" data-testid="wz-abuse-link"/.exec(html)?.[1]?.replace(/&#38;/g, "&");

describe("«Пожаловаться» in prod documents", () => {
  it("injectAbuseLink: before </body>, once, attribute-escaped", () => {
    const out = injectAbuseLink(INDEX, {
      platformOrigin: "https://wizard.example/",
      pageUrl: 'https://a.sys.example/x"y',
    });
    expect(out.indexOf("Пожаловаться")).toBeLessThan(out.indexOf("</body>"));
    expect(
      injectAbuseLink(out, { platformOrigin: "https://wizard.example", pageUrl: "https://a.sys.example/" }),
    ).toBe(out);
    expect(out).not.toContain('x"y');
    expect(abuseFormUrl("https://wizard.example/", "https://a.sys.example/p")).toBe(
      "https://wizard.example/abuse?url=https%3A%2F%2Fa.sys.example%2Fp",
    );
  });

  it("prod index and SPA routes carry the link to the platform form with the page URL", async () => {
    writeRegistry([entry(), entry({ env: "draft" })]);
    const home = await rt.fetch(request("GET", PROD, "/"));
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(">Пожаловаться</a>");
    expect(linkHref(html)).toBe(abuseFormUrl(devEnv.platformOrigin, `http://${PROD}/`));
    const deep = await (await rt.fetch(request("GET", PROD, "/tickets/42"))).text();
    expect(linkHref(deep)).toBe(abuseFormUrl(devEnv.platformOrigin, `http://${PROD}/tickets/42`));
    const login = await (await rt.fetch(request("GET", PROD, "/login"))).text();
    expect(login).toContain('data-testid="wz-abuse-link"');
  });

  it("draft documents have no link (closed previews)", async () => {
    writeRegistry([entry(), entry({ env: "draft" })]);
    const res = await rt.fetch(request("GET", DRAFT, "/"));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("wz-abuse-link");
  });

  it("taken down → 451 «Система временно недоступна по жалобе. Владелец системы уведомлён.»; health 200; restore → 200", async () => {
    writeRegistry([entry({ suspended: true })]);
    for (const path of ["/", "/login", "/tickets/42", "/api/data/stream", "/manifest.webmanifest"]) {
      const res = await rt.fetch(request("GET", PROD, path));
      expect(res.status, path).toBe(451);
      const text = await res.text();
      expect(text).toContain("Система временно недоступна по жалобе");
      expect(text).toContain("Владелец системы уведомлён.");
      expect(text).not.toContain("wz-abuse-link");
    }
    expect((await rt.fetch(request("GET", PROD, "/_wizard/health"))).status).toBe(200);
    writeRegistry([entry()]);
    expect((await rt.fetch(request("GET", PROD, "/"))).status).toBe(200);
  });
});
