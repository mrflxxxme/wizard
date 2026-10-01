// M1-12 on the M1 stand: S-import (platform-screens.yaml) — an xlsx with canary rows is uploaded from the workspace,
// the proposed mapping is shown without cell values («Телефон» marked basic), one column is re-mapped, the import is
// confirmed (needs_input import_confirm) and the rows appear in the preview's data; the mock model providers never
// saw a canary value (data-boundary.yaml#import). A viewer cannot import (button disabled, direct POST → 403).
import { readFileSync } from "node:fs";
import { type BrowserContext, expect, test } from "@playwright/test";
import { writeXlsx } from "@wizard/pii/import";
import { M1, M1_LLM_LOG } from "../../stand/ports.js";
import {
  type Api,
  builtForum,
  devLogin,
  type Json,
  lastLetter,
  ownerOrg,
  uniqueEmail,
  WEB,
  waitRun,
} from "./helpers.js";

test.describe.configure({ mode: "serial" });

const N = 12;
const FIRST = ["Всеволод", "Агния", "Джахонгир", "Зульфия", "Ростислав", "Милена"];
const LAST = ["Кривошеин", "Белозерова", "Рахимов", "Абдуллаева", "Задонский", "Ветрова"];
const tag = Math.random().toString(36).slice(2, 7);

/** Canary rows: stream names, capacities and descriptions are imported; curators and phones are skipped. */
const rows = Array.from({ length: N }, (_, i) => ({
  name: `Поток канарейка ${tag} ${i + 1}`,
  capacity: 50 + i * 10,
  description: `Описание канарейка ${tag}-${i + 1}`,
  curator: `${LAST[i % LAST.length]} ${FIRST[(i * 5) % FIRST.length]}`,
  phone: `+7 916 5${String(10 + i)}-${String(30 + i)}-${String(70 + i)}`,
}));
const canaries = rows.flatMap((r) => [r.name, r.description, r.curator, r.phone]);

function xlsx(): Buffer {
  const grid: (string | number)[][] = [
    ["Название потока", "Вместимость", "Описание", "Куратор", "Телефон"],
    ...rows.map((r) => [r.name, r.capacity, r.description, r.curator, r.phone]),
  ];
  return Buffer.from(writeXlsx([{ name: "Потоки", rows: grid }]));
}

let ownerCtx: BrowserContext;
let owner: Api;
let orgId = "";
let system: Json;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ownerCtx = await browser.newContext();
  owner = await devLogin(ownerCtx, uniqueEmail("import-owner"));
  orgId = await ownerOrg(owner);
  system = await builtForum(owner, orgId);
});

test.afterAll(async () => {
  await ownerCtx?.close();
});

test("S-import: xlsx → предложенное сопоставление → правка колонки → импорт; строки в данных превью", async () => {
  test.setTimeout(180_000);
  const page = await ownerCtx.newPage();
  await page.goto(`/s/${system.id}`);
  await expect(page.getByTestId("chat-upload")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("chat-upload-file").setInputFiles({
    name: "Потоки Кривошеина.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: xlsx(),
  });
  await expect(page).toHaveURL(new RegExp(`/s/${system.id}/import/[0-9a-f-]{36}$`));
  const importId = page.url().split("/import/")[1] ?? "";

  await expect(page.getByTestId("import-notice")).toContainText(
    "Моделям за рубежом передаются только названия колонок и синтетические строки",
  );
  await expect(page.getByTestId("import-confirm")).toBeEnabled({ timeout: 60_000 });
  for (const c of ["Название потока", "Вместимость", "Описание", "Куратор", "Телефон"])
    await expect(page.getByTestId(`import-row-${c}`)).toBeVisible();
  await expect(page.getByTestId("import-pii-Телефон")).toHaveValue("basic");
  await expect(page.getByTestId("import-target-Название потока")).toHaveValue("map:stream.name");
  await expect(page.getByTestId("import-target-Вместимость")).toHaveValue("map:stream.capacity");
  await expect(page.getByTestId("import-target-Описание")).toHaveValue("skip");
  await expect(page.getByTestId("import-target-Телефон")).toHaveValue("skip");

  // Only the schema is on screen: no cell value, neither from the file nor from the mapper's answer.
  const text = await page.locator("body").innerText();
  for (const v of canaries) expect(text).not.toContain(v);

  // 390px: one card per column, no horizontal scroll (platform-screens.yaml#stack).
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (size) await page.setViewportSize(size);

  await page.getByTestId("import-target-Описание").selectOption("map:stream.description");
  await expect(page.getByTestId("import-confirm")).toHaveText("Загрузить 3 колонки");
  await page.getByTestId("import-confirm").click();
  await expect(page.getByTestId("import-result")).toContainText(`Импортировано строк: ${N}`, {
    timeout: 60_000,
  });

  const imp = await owner.req("GET", `/systems/${system.id}/imports/${importId}`);
  expect(imp.body.status).toBe("done");
  expect(imp.body.rowsImported).toBe(N);
  expect(imp.body.mapping.find((m: Json) => m.column === "Описание")).toMatchObject({
    action: "map",
    entity: "stream",
    field: "description",
  });
  const run = await waitRun(owner, imp.body.runId);
  expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
  expect(run.kind).toBe("import_table");

  // The mapper was called (propose_mapping) and saw no real value.
  const log = readFileSync(M1_LLM_LOG, "utf8");
  expect(log).toContain("propose_mapping");
  for (const v of canaries) expect(log).not.toContain(v);

  // Rows in the preview's data: the draft host of the system, visitor (public) role.
  const draft = `http://${system.slug}--draft.localhost:${M1.runtime}`;
  const data = await ownerCtx.newPage();
  const res = await data.goto(
    `${draft}/api/data/stream?limit=100&filter[name][contains]=${encodeURIComponent(tag)}`,
  );
  if (!res) throw new Error("no response from the draft host");
  expect(res.status()).toBe(200);
  const items = ((await res.json()) as { items: Json[] }).items;
  expect(items.map((x) => x.name).sort()).toEqual(rows.map((r) => r.name).sort());
  const first = items.find((x) => x.name === rows[0]?.name);
  expect(first).toMatchObject({ capacity: rows[0]?.capacity, description: rows[0]?.description });

  // «Открыть превью» goes back to the workspace.
  await page.getByTestId("import-open-system").click();
  await expect(page).toHaveURL(`${WEB}/s/${system.id}`);
});

test("наблюдатель не может импортировать: кнопка недоступна, прямой POST → 403", async ({ browser }) => {
  const email = uniqueEmail("import-viewer");
  const inv = await owner.req("POST", `/orgs/${orgId}/invites`, { email, role: "viewer" });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const link = (await lastLetter(email, "invite")).match(/\/invite\/[A-Za-z0-9_-]+/)?.[0] ?? "";
  const ctx = await browser.newContext();
  await devLogin(ctx, email);
  const page = await ctx.newPage();
  await page.goto(link);
  await page.getByTestId("invite-accept").click();
  await expect(page).toHaveURL(`${WEB}/`);

  await page.goto(`/s/${system.id}`);
  await expect(page.getByTestId("chat-upload")).toBeDisabled();
  await expect(page.getByText("Загружает таблицы редактор или владелец")).toBeVisible();

  const cookies = await ctx.cookies(WEB);
  const csrf = cookies.find((c) => c.name === "wizard_csrf")?.value ?? "";
  const res = await ctx.request.post(`${WEB}/api/v1/systems/${system.id}/imports`, {
    headers: { Origin: WEB, "X-Wizard-CSRF": csrf },
    multipart: {
      file: { name: "t.xlsx", mimeType: "application/octet-stream", buffer: xlsx() },
    },
  });
  expect(res.status()).toBe(403);
  // getImport is editor+ as well: the S-import screen tells the viewer so.
  await page.goto(`/s/${system.id}/import/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByTestId("import-error")).toHaveText("Импорт таблиц доступен редактору и владельцу");
  await ctx.close();
});
