import { type APIRequestContext, expect, test } from "@playwright/test";

// Endpoints: specs/platform/deploy.yaml#local (ports, M0 exit test), specs/runtime/runtime.yaml (health).
const API = "http://127.0.0.1:4000";
const RUNTIME = "http://127.0.0.1:4100";
const WEB = "http://127.0.0.1:5173";
// scripts/dev.mjs marks its stub servers with this header.
const STUB_HEADER = "x-wizard-dev-stub";

async function status(request: APIRequestContext, url: string): Promise<number> {
  try {
    return (await request.get(url)).status();
  } catch {
    return 0;
  }
}

async function isStub(request: APIRequestContext, url: string): Promise<boolean> {
  const res = await request.get(url);
  return res.headers()[STUB_HEADER] !== undefined;
}

test("dev-стенд: platform-api, runtime и platform-web отвечают", async ({ request }) => {
  for (const url of [`${API}/api/v1/systems`, `${RUNTIME}/_wizard/health`, `${WEB}/`]) {
    await expect
      .poll(
        async () => {
          const s = await status(request, url);
          return s > 0 && s < 500;
        },
        { message: url, timeout: 60_000 },
      )
      .toBe(true);
  }
});

test("Chromium открывает платформу", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.ok()).toBe(true);
  await expect(page.locator("body")).not.toBeEmpty();
});

// SKIPPED UNTIL APPS EXIST: each test below runs only when the app is real, not a dev.mjs stub.
test.describe("реальные приложения (пропускаются, пока app — заглушка dev.mjs)", () => {
  test("platform-api: GET /api/v1/systems → 200 (M0-15)", async ({ request }) => {
    test.skip(await isStub(request, `${API}/api/v1/systems`), "platform-api — заглушка, ждёт M0-15");
    expect((await request.get(`${API}/api/v1/systems`)).status()).toBe(200);
  });

  test("runtime: GET /_wizard/health → 200 {status: ok} (M0-09)", async ({ request }) => {
    test.skip(await isStub(request, `${RUNTIME}/_wizard/health`), "runtime — заглушка, ждёт M0-09");
    const res = await request.get(`${RUNTIME}/_wizard/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("platform-web: страница на русском, без ошибок JS (M0-16)", async ({ page, request }) => {
    test.skip(await isStub(request, `${WEB}/`), "platform-web — заглушка, ждёт M0-16");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });
});
