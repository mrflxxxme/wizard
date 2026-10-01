// M0-24: forum bundle served on <slug>--draft.localhost:4100 (runtime.yaml#static, #security_headers),
// bridge/wz-map only on draft (platform-screens.yaml#preview_contract, ui-kit.yaml#wz_id.prod).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { request } from "./helpers.js";
import { PLATFORM, type PreviewFixture, previewFixture } from "./preview-helpers.js";

let fx: PreviewFixture;
const DRAFT = "forum--draft.localhost:4100";
const PROD = "forum.localhost:4100";
const get = (host: string, path: string) => fx.rt.fetch(request("GET", host, path));

beforeAll(async () => {
  fx = await previewFixture();
  const key = "f0rum0000001";
  await fx.publish({ slug: "forum", env: "draft", revision: 1, key });
  await fx.publish({ slug: "forum", env: "prod", revision: 2, key });
}, 60_000);
afterAll(() => fx?.close());

describe("draft bundle", () => {
  test("index.html with no-cache, CSP, frame-ancestors = platform origin, bridge script", async () => {
    const res = await get(DRAFT, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp.endsWith(`frame-ancestors ${PLATFORM}`)).toBe(true);
    expect(csp).not.toMatch(/https?:\/\/(?!localhost:5173)/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(self), geolocation=()");
    expect([...res.headers.keys()].some((k) => k.startsWith("access-control-"))).toBe(false);
    const html = await res.text();
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain('<script src="/_wizard/bridge.js"></script>');
  });

  test("SPA fallback: page routes and unknown paths get index.html", async () => {
    const index = await (await get(DRAFT, "/")).text();
    for (const path of ["/ticket/123", "/scanner", "/nope/deep?x=1"]) {
      const res = await get(DRAFT, path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(index);
    }
  });

  test("hashed assets are immutable; content types by extension", async () => {
    const html = await (await get(DRAFT, "/")).text();
    const js = /src="(\/assets\/index-[0-9a-f]{12}\.js)"/.exec(html)?.[1] as string;
    expect(js).toBeTruthy();
    const res = await get(DRAFT, js);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await res.text()).length).toBeGreaterThan(1000);
    const head = await fx.rt.fetch(request("HEAD", DRAFT, js));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("missing assets and path tricks → 404, never files outside client/assets", async () => {
    for (const path of [
      "/assets/nope.js",
      "/assets/%2e%2e%2fmanifest.json",
      "/assets/..%2F..%2Fspec.json",
      "/assets/.",
      "/assets/%00.js",
      "/assets/sub/dir.js",
    ]) {
      const res = await get(DRAFT, path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("specHash");
    }
    // URL normalization turns /assets/../spec.json into /spec.json: the SPA shell, not the artifact file.
    const res = await get(DRAFT, "/assets/../spec.json");
    expect(await res.text()).not.toContain("specHash");
  });

  test("non-GET on static paths → 405", async () => {
    const res = await fx.rt.fetch(request("POST", DRAFT, "/", { body: {} }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  test("PWA files are served for every system (M2-03; details in qr-offline.test.ts)", async () => {
    expect((await get(DRAFT, "/sw.js")).status).toBe(200);
    expect((await get(DRAFT, "/manifest.webmanifest")).status).toBe(200);
  });

  test("bridge.js: platform origin and revision baked in, no-cache JS", async () => {
    const res = await get(DRAFT, "/_wizard/bridge.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const js = await res.text();
    expect(js).toContain(`wizardBridge(window, {"platformOrigin":"${PLATFORM}","revision":1});`);
    expect(js).not.toContain("'*'");
  });

  test("wz-map.json is served from the draft artifact", async () => {
    const res = await get(DRAFT, "/_wizard/wz-map.json");
    expect(res.status).toBe(200);
    const map = (await res.json()) as Record<string, { file: string; line: number; componentName: string }>;
    const first = Object.values(map)[0];
    expect(first?.file).toMatch(/^ui\//);
    expect(typeof first?.line).toBe("number");
  });

  test("/login: runtime template with dev-login links (next is sanitized)", async () => {
    const res = await get(DRAFT, "/login?next=//evil.example&role=participant");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Вход");
    expect(html).toContain("/_wizard/dev-login?role=participant&#38;next=%2F");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("role=organizer");
  });

  test("policy page renders operator details and consent text", async () => {
    const res = await get(DRAFT, "/privacy");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Политика обработки персональных данных");
    expect(html).toContain("ООО «Северный ритейл»");
  });
});

describe("prod bundle", () => {
  test("index.html without the bridge; frame-ancestors 'none'", async () => {
    const res = await get(PROD, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'$/);
    expect(await res.text()).not.toContain("bridge.js");
  });

  test("bridge.js, wz-map.json and pay-mock do not exist on prod", async () => {
    for (const path of [
      "/_wizard/bridge.js",
      "/_wizard/wz-map.json",
      "/_wizard/pay-mock?binding=ticket&id=x",
    ]) {
      expect((await get(PROD, path)).status, path).toBe(404);
    }
  });
});
