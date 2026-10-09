// V3-21 «Окно ключа в чате» in chromium, 390 and 1280 px × light and dark, on a v3 system of the canvas (the recorded
// grill interview of test/v3/fake-v3.ts): a key typed into the chat is not sent — the composer keeps the message masked
// and the alert offers the window; the platform's window shows the integration and the hosts, takes the key in a
// masked field, encrypts it with the window's public key in the page (WebCrypto; this test opens the ciphertext with the
// private half it keeps) and returns the message with secret://crm_key; the key is never in the DOM, the card fits the
// screen, no horizontal scroll. Screenshots in test/artifacts/v3-keys-*.png. Nothing calls a model.
import { webcrypto } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openSealedSecret } from "../../platform-api/src/secrets-v3/crypto.js";
import type { SealedSecret } from "../src/screens/v3/keys/index.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const WIN = "44444444-4444-4444-8444-444444444444";
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const hex = (n: number) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex");

/** The key routes of one system: a window with a real P-256 pair whose private half stays in the test. */
async function serveKeys(page: Page, systemId: string) {
  const kp = (await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey("jwk", kp.publicKey);
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", kp.privateKey));
  const context = `wz-key-window/v1:${WIN}:${systemId}:draft:crm_key`;
  const base = {
    id: WIN,
    env: "draft",
    name: "crm_key",
    secretRef: "secret://crm_key",
    integrationId: "crm",
    integrationName: "Partner CRM: заявки",
    hosts: ["api.partner-crm.ru"],
    purpose: "Подключить «Partner CRM: заявки» к системе",
    requestedBy: "user",
    status: "open",
    expiresAt: "2026-10-10T09:00:00.000Z",
    createdAt: "2026-10-09T09:00:00.000Z",
  };
  const window = {
    ...base,
    alg: "ECDH-ES+HKDF-SHA256+A256GCM",
    publicKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    context,
    form: null,
  };
  const st = {
    saved: false,
    submitted: [] as SealedSecret[],
    open: (s: SealedSecret) => openSealedSecret(pkcs8, s, WIN, context),
  };
  const needed = () => [
    {
      integrationId: "crm",
      integrationName: "Partner CRM: заявки",
      name: "crm_key",
      secretRef: "secret://crm_key",
      hosts: ["api.partner-crm.ru"],
      present: st.saved,
      keyless: false,
      account: null,
    },
  ];
  const secret = () => ({
    name: "crm_key",
    secretRef: "secret://crm_key",
    env: "draft",
    integrationId: "crm",
    integrationName: "Partner CRM: заявки",
    hosts: ["api.partner-crm.ru"],
    last4: "9f3c",
    version: 1,
    status: "ok",
    check: { code: "OK", message_ru: "Ключ принят", checkedAt: "2026-10-09T09:00:00.000Z" },
    rotatedAt: null,
    createdAt: "2026-10-09T09:00:00.000Z",
  });
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
  await page.route(
    new RegExp(`/api/v1/systems/${systemId}/(secrets|secret-windows)(/.*)?(\\?.*)?$`),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(`/api/v1/systems/${systemId}`, "");
      if (path === "/secrets")
        return json(route, 200, { items: st.saved ? [secret()] : [], windows: [], needed: needed() });
      if (path === "/secret-windows" && req.method() === "POST") return json(route, 201, { window });
      if (path === `/secret-windows/${WIN}`) return json(route, 200, { window });
      if (path === `/secret-windows/${WIN}/submit`) {
        st.submitted.push(JSON.parse(req.postData() ?? "{}") as SealedSecret);
        st.saved = true;
        return json(route, 200, {
          saved: true,
          secret: secret(),
          checks: [{ integrationId: "crm", ok: true, status: "live", message_ru: "Ключ принят" }],
          message_ru: "Ключ сохранён: ••••9f3c и проверен. Ключ принят",
        });
      }
      return json(route, 404, { code: "NOT_FOUND", message_ru: "Не найдено" });
    },
  );
  return st;
}

describe.skipIf(!hasChromium)("the key window in the canvas chat (chromium)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: loadCanvasFeed(), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  for (const vp of [
    { width: 390, height: 844 },
    { width: 1280, height: 860 },
  ] as const)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: a typed key is intercepted, encrypted in the window, back as secret://crm_key`, async () => {
        const tag = `${vp.width}-${scheme}`;
        const KEY = `crm-live-${hex(14)}`;
        const page = await h.page({ viewport: vp, colorScheme: scheme, reducedMotion: "reduce" });
        const fake = new FakeV3();
        await serveV3(page, fake);
        const keys = await serveKeys(page, fake.systemId);
        const posted: string[] = [];
        page.on("request", (r) => {
          if (r.method() !== "GET")
            posted.push(`${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ""}`);
        });
        await page.getByTestId("start-prompt").fill("Стоматология в Казани, онлайн-запись к врачам");
        await page.getByTestId("start-submit").click();
        await page.waitForURL(new RegExp(`/s/${fake.systemId}$`));
        await page.getByTestId("canvas-question").waitFor();
        // The first answer writes the brief: the system is a v3 one, its key window is on.
        await page.getByTestId("p-question-option-o1").click();
        await expect
          .poll(() => page.getByTestId("canvas-question").locator("p").first().textContent())
          .toBe("Вопрос 2");
        await page.getByTestId("key-needed").waitFor();

        const input = page.getByTestId("p-composer-input");
        await input.fill(`Подключи CRM, вот ключ API: ${KEY}`);
        await page.getByTestId("p-composer-send").click();
        const alert = page.getByTestId("key-intercept");
        await alert.waitFor();
        expect(await alert.getAttribute("role")).toBe("alert");
        expect(await input.inputValue()).toBe("Подключи CRM, вот ключ API: [ключ скрыт]");
        expect(
          posted
            .filter((p) => p.includes("/answers") || p.includes("/messages"))
            .some((p) => p.includes(KEY)),
        ).toBe(false);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-keys-${tag}-1-intercept.png`) });

        await page.getByTestId("key-intercept-open").click();
        const win = page.getByTestId("key-window");
        await win.waitFor();
        expect(await page.getByTestId("key-hosts").textContent()).toBe("api.partner-crm.ru");
        const field = page.getByTestId("key-input");
        expect(await field.getAttribute("type")).toBe("password");
        expect((await field.inputValue()) === KEY).toBe(true);
        expect(await field.evaluate((el) => el === document.activeElement)).toBe(true);
        expect((await page.content()).includes(KEY)).toBe(false);
        const box = await win.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
        }
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-keys-${tag}-2-window.png`) });

        await page.getByTestId("key-save").click();
        await page.getByTestId("key-result").waitFor();
        expect(await page.getByTestId("key-result-text").textContent()).toMatch(/^Ключ сохранён: ••••9f3c/);
        expect(keys.submitted).toHaveLength(1);
        const sealed = keys.submitted[0] as SealedSecret;
        expect(JSON.stringify(sealed).includes(KEY)).toBe(false);
        expect((await keys.open(sealed)) === KEY).toBe(true);
        expect(posted.some((p) => p.includes(KEY))).toBe(false);
        expect(await input.inputValue()).toBe("Подключи CRM, вот ключ API: secret://crm_key");
        expect((await page.content()).includes(KEY)).toBe(false);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-keys-${tag}-3-saved.png`) });
        await page.getByTestId("key-done").click();
        await page.getByTestId("key-row").waitFor();
        expect(await page.getByTestId("key-row").textContent()).toContain("••••9f3c · проверен");
        await page.context().close();
      }, 90_000);
});
