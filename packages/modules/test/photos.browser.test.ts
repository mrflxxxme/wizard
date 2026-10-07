// B2-38 acceptance (browser): the landing row with stock photos (LANDING_PHOTO_ROW: collage hero, alternating features,
// story, gallery) whose copies are in the platform photo library passes G0 and G1 in Chromium — the landing goal
// scenarios, the owner's one-click replacement (GS-landing-2) and every page at 390 px without sideways scroll. At 390
// and 1280 px every stock photo loads from the system's own origin (/_wizard/photos), the gallery tile without a photo
// keeps the theme graphic, the footer links «Источники фото» with the author, the photo page and the licence of each
// picture; after the owner replaced a photo the page shows the owner's picture and the credits no longer list that place.
// Without photos (no stock) the same sections show the theme graphic. Screenshots: test/artifacts/photos-*.png.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import {
  type GateContext,
  type GateReport,
  type GoalProgram,
  type GoalScenarioInput,
  runG0,
  runG1,
} from "@wizard/gates";
import {
  closeExecutors,
  createRuntimeApp,
  MemoryFileStorage,
  MemoryRegistry,
  type RuntimeApp,
  storeLibraryPhoto,
} from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodeJpeg, photo } from "../../../apps/runtime/test/media-helpers.js";
import {
  type CompileSuccess,
  compilePlan,
  examplePhotos,
  LANDING_PHOTO_ROW,
  matrixPlan,
  PHOTO_ROW_SLOTS,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "artifacts");
const registry = testRegistry();
const keyPrefix = `b238${randomBytes(3).toString("hex")}`;
const storage = new MemoryFileStorage();

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;
let files: string[] = [];

/** A photo-like JPEG of the n-th example in its own tint (portrait for the first collage picture). */
async function examplePicture(i: number): Promise<Uint8Array> {
  const [w, h] = i === 0 ? [900, 1200] : i < 3 ? [900, 900] : [1200, 800];
  const d = photo(w, h);
  for (let p = 0; p < d.length; p += 4) {
    d[p] = ((d[p] as number) + i * 23) % 256;
    d[p + 2] = ((d[p + 2] as number) + i * 41) % 256;
  }
  return encodeJpeg(d, w, h);
}

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_photo_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-photos-test-"));
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: serializeQrKeyring(newQrKeyring()) }),
    files: storage,
    env: {
      authModeDev: true,
      devLogin: false,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
  // The builder's copies: the example photos of the row in the platform photo library.
  files = [];
  for (let i = 0; i < PHOTO_ROW_SLOTS.length; i++)
    files.push((await storeLibraryPhoto(storage, await examplePicture(i), { source: `example:${i}` })).id);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  if (!hasChromium) return;
  await browser?.close();
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Пример: студия" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

/** What the visitor's page shows: library and owner pictures (loaded or not), placeholders, sideways scroll. */
const PROBE = async () => {
  const imgs = [...document.querySelectorAll("img")] as HTMLImageElement[];
  for (const i of imgs) {
    i.loading = "eager";
    await i.decode().catch(() => {});
  }
  const src = (i: HTMLImageElement) => i.getAttribute("src") ?? "";
  return {
    stock: imgs
      .filter((i) => src(i).startsWith("/_wizard/photos/"))
      .map((i) => ({ src: src(i), w: i.naturalWidth })),
    own: imgs
      .filter((i) => src(i).startsWith("/api/files/"))
      .map((i) => ({ src: src(i), w: i.naturalWidth })),
    external: imgs.filter((i) => /^https?:/.test(src(i))).map(src),
    placeholders: document.querySelectorAll('[data-testid="wz-placeholder"]').length,
    sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    credits: [...document.querySelectorAll('a[href="/photos"]')].map((a) => a.textContent),
  };
};

/** The visitor's landing at the cell's width: photos from the system's origin, screenshot. */
function landingShots(expectStock: boolean): GoalProgram {
  return async (t) => {
    t.step("Посетитель открывает главную страницу с фото");
    await t.as("visitor");
    await t.open("/");
    const r = await t.page.evaluate(PROBE);
    const cell = `${t.viewport.width}-${t.scheme}`;
    writeFileSync(
      join(ARTIFACTS, `photos-${expectStock ? "stock" : "graphic"}-${cell}.png`),
      await t.page.screenshot({ fullPage: true }),
    );
    if (r.external.length) t.fail("картинки с чужих адресов", r.external.join(", "));
    if (r.sideways) t.fail("страница прокручивается вбок");
    if (!expectStock) {
      if (r.stock.length) t.fail("без стока на странице есть фото со стока");
      if (r.placeholders < PHOTO_ROW_SLOTS.length)
        t.fail("без фото нет графики оформления", String(r.placeholders));
      return;
    }
    const broken = r.stock.filter((x) => x.w === 0);
    if (broken.length) t.fail("фото со стока не загрузились", broken.map((x) => x.src).join(", "));
    if (r.stock.length < PHOTO_ROW_SLOTS.length)
      t.fail("на странице не все фото со стока", `${r.stock.length} из ${PHOTO_ROW_SLOTS.length}`);
    if (r.placeholders !== 1)
      t.fail("плитка галереи без фото должна показывать графику", String(r.placeholders));
    if (!r.credits.includes("Источники фото")) t.fail("в подвале нет ссылки «Источники фото»");
    t.step("Посетитель открывает «Источники фото»");
    await t.open("/photos");
    await t.expectText("Источники фото");
    await t.expectText("Пример: автор 1");
    await t.expectText("Лицензия на контент Pixabay");
    const links = await t.page
      .locator('[data-testid="wz-photo-credits"] a')
      .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    if (
      !links.includes("https://www.pexels.com/license/") ||
      !links.some((h) => h.includes("/photo/example-"))
    )
      t.fail("у фото нет ссылки на лицензию или страницу фото", links.join(", "));
    writeFileSync(join(ARTIFACTS, `photos-credits-${cell}.png`), await t.page.screenshot({ fullPage: true }));
  };
}

/** The owner replaces the first photo: the visitor sees it there, the credits drop that place. */
const ownerReplaces: GoalProgram = async (t) => {
  t.step("Владелец открывает «Фото сайта»");
  await t.as("owner");
  await t.open("/cabinet/photos");
  const card = t.page.locator('[data-testid="wz-site-photo-top"]');
  await t.expectText("Фото со стока Pexels, автор Пример: автор 1", {
    within: '[data-testid="wz-site-photo-top"]',
  });
  writeFileSync(
    join(ARTIFACTS, `photos-cabinet-${t.viewport.width}-${t.scheme}.png`),
    await t.page.screenshot({ fullPage: true }),
  );
  t.step("Владелец выбирает своё фото — одно действие");
  await card.locator('input[type="file"]').setInputFiles({
    name: "my.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(await encodeJpeg(photo(800, 600), 800, 600)),
  });
  await t.expectText("Ваше фото.", { within: '[data-testid="wz-site-photo-top"]', timeoutMs: 15_000 });
  const row = (await t.rows("site_photo")).find((r) => r.slot === "top");
  if (typeof row?.image !== "string") t.fail("фото владельца не сохранилось");
  t.step("Посетитель видит фото владельца на первом экране");
  await t.as("visitor");
  await t.open("/");
  const r = await t.page.evaluate(PROBE);
  if (!r.own.some((x) => x.src.includes(String(row?.image)) && x.w > 0))
    t.fail("на главной нет фото владельца");
  if (r.stock.length !== PHOTO_ROW_SLOTS.length - 1)
    t.fail("остальные фото со стока должны остаться", String(r.stock.length));
  writeFileSync(
    join(ARTIFACTS, `photos-replaced-${t.viewport.width}-${t.scheme}.png`),
    await t.page.screenshot(),
  );
  t.step("В «Источниках фото» больше нет заменённого места");
  await t.open("/photos");
  const text = await t.page.locator('[data-testid="wz-photo-credits"]').innerText();
  if (text.includes("Первый экран, фото 1:")) t.fail("заменённое фото осталось в источниках");
  if (!text.includes("Первый экран, фото 2:")) t.fail("в источниках пропали остальные фото");
};

const scenario = (id: string, title: string): GoalScenarioInput => ({
  id,
  module: "landing",
  goal: "attract",
  title,
  steps: [],
  expect: [],
});

async function gates(plan: unknown, programs: Record<string, GoalProgram>) {
  const r = compiled(plan);
  const ctx: GateContext = {
    spec: r.spec as AppSpec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(r.files)),
    env: "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M1",
    runtime: rt,
    runtimeRole: role,
    browser,
    goalScenarios: [
      ...r.scenarios.filter((s) => s.module === "landing"),
      ...Object.keys(programs).map((id) => scenario(id, id)),
    ],
  };
  expect(failed(await runG0(ctx)), "G0").toEqual([]);
  const g1 = await runG1(ctx, { goals: { programs } });
  expect(failed(g1), "G1").toEqual([]);
  return g1;
}

describe.skipIf(!hasChromium)("stock photos on the landing (B2-38)", () => {
  test("photos from the library at 390 and 1280, credits, owner's one-click replacement; G0 and G1", async () => {
    const photos = examplePhotos((_slot, i) => files[i] as string);
    const plan = matrixPlan(registry, "landing", { ...LANDING_PHOTO_ROW, photos });
    const g1 = await gates(plan, { "B238-photos": landingShots(true), "B238-replace": ownerReplaces });
    for (const id of [
      "G1-RENDER-01",
      "G1-MOBILE-01",
      "G1-GOAL-GS-landing-1",
      "G1-GOAL-GS-landing-2",
      "G1-GOAL-B238-photos",
      "G1-GOAL-B238-replace",
    ])
      expect(g1.checks.find((c) => c.id === id)?.status, id).toBe("pass");
    for (const f of ["photos-stock-390-light.png", "photos-stock-1280-dark.png"])
      expect(existsSync(join(ARTIFACTS, f)), f).toBe(true);
  }, 300_000);

  test("without a stock the same sections show the theme graphic; the owner can still put a photo", async () => {
    const { photos: _p, ...row } = LANDING_PHOTO_ROW;
    const plan = matrixPlan(registry, "landing", row);
    const g1 = await gates(plan, { "B238-graphic": landingShots(false) });
    for (const id of ["G1-GOAL-B238-graphic", "G1-GOAL-GS-landing-2"])
      expect(g1.checks.find((c) => c.id === id)?.status, id).toBe("pass");
  }, 300_000);
});
