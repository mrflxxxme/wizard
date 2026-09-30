// Typed API client (api.yaml M0) against the mock platform: Idempotency-Key per mutation, Error.message_ru.
import { afterAll, beforeAll, expect, test } from "vitest";
import { ApiError, createApiClient } from "../src/api/client.js";
import { loadFeed, MockPlatform } from "./mock/server.js";

let mock: MockPlatform;
let api: ReturnType<typeof createApiClient>;

beforeAll(async () => {
  mock = await new MockPlatform({
    feed: loadFeed("forum"),
    platformOrigin: "http://localhost:5173",
    eventDelayMs: 1,
  }).start();
  api = createApiClient({ base: `${mock.apiTarget}/api/v1`, devUser: "dev@wizard.local" });
});
afterAll(async () => mock?.close());

test("createSystem sends Idempotency-Key and X-Wizard-Dev-User; each call a new key", async () => {
  const a = await api.createSystem({ prompt: "Форум на 600 человек" });
  await api.createSystem({ prompt: "Форум на 600 человек" });
  expect(a.system.stage).toBe("interview");
  const posts = mock.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/systems");
  expect(posts).toHaveLength(2);
  const keys = posts.map((p) => p.headers["idempotency-key"]);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[0]).not.toBe(keys[1]);
  expect(posts[0]?.headers["x-wizard-dev-user"]).toBe("dev@wizard.local");
  expect(posts[0]?.body).toEqual({ prompt: "Форум на 600 человек" });
});

test("errors become ApiError with code, status and message_ru", async () => {
  const e = await api.getSystem("00000000-0000-0000-0000-00000000dead").catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect(e).toMatchObject({ status: 404, code: "NOT_FOUND", message: "Система не найдена" });
  const { system } = await api.createSystem({ prompt: "Ещё одна система" });
  const p = await api.getPreviewUrl(system.id).catch((x: unknown) => x);
  expect(p).toMatchObject({ status: 409, code: "PREVIEW_NOT_READY" });
});

test("network failure → ApiError NETWORK in Russian", async () => {
  const off = createApiClient({ base: "http://127.0.0.1:9/api/v1" });
  await expect(off.listSystems()).rejects.toMatchObject({
    code: "NETWORK",
    message: "Нет связи с сервером. Проверьте подключение и повторите.",
  });
});

test("eventsUrl carries after", () => {
  expect(api.eventsUrl("r1", 5)).toBe(`${mock.apiTarget}/api/v1/runs/r1/events?after=5`);
});
