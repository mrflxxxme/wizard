// Goal scenarios of the module «Секции лендинга» (packages/modules/src/landing): the public page «/» of ui-kit blocks
// and the owner's photos of its sections (B2-38).
import { deflateSync } from "node:zlib";
import type { GoalProgram } from "../types.js";
import { component } from "./shared.js";

/** Forms a hero action may lead to: the lead form, a booking form, any form of the page. */
const FORMS = `${component("LeadForm")}, ${component("BookingForm")}, form`;

/** GS-landing-1: the hero heading is visible without scrolling; the main action leads to the form on this page. */
const heroAction: GoalProgram = async (t) => {
  t.step("Посетитель открывает главную страницу");
  await t.as("visitor");
  await t.open("/");

  t.step("Заголовок первого экрана виден без прокрутки");
  const h1 = t.page.locator("h1").first();
  if ((await h1.count()) === 0) t.fail("на главной нет заголовка первого экрана");
  const box = await h1.boundingBox();
  const title = ((await h1.innerText().catch(() => "")) || "").trim();
  if (!title) t.fail("заголовок первого экрана пустой");
  if (!box || !(await h1.isVisible()) || box.y < 0 || box.y + box.height > t.viewport.height)
    t.fail(
      "заголовок первого экрана не виден без прокрутки",
      box ? `верх ${Math.round(box.y)} px, низ ${Math.round(box.y + box.height)} px` : undefined,
    );

  t.step("Посетитель нажимает главную кнопку первого экрана");
  const hasForm = (await t.page.locator(FORMS).count()) > 0;
  const action = t.page.locator(`${component("Hero")} [data-testid="wz-hero-primary"]`).first();
  if ((await action.count()) === 0) {
    if (hasForm) t.fail("на первом экране нет кнопки, которая ведёт к форме");
    return;
  }
  const href = (await action.getAttribute("href")) ?? "";
  if (!href.startsWith("#")) {
    if (hasForm)
      t.fail("кнопка первого экрана ведёт не к форме на этой странице", `ссылка ${href || "пустая"}`);
    return;
  }
  await action.click();
  await t.page.waitForTimeout(300);

  t.step("Кнопка ведёт к форме заявки или записи на этой же странице");
  const target = t.page.locator(`[id="${href.slice(1).replace(/"/g, "")}"]`).first();
  if ((await target.count()) === 0)
    t.fail("кнопка первого экрана ведёт к блоку, которого нет на странице", href);
  if (hasForm && (await target.locator(FORMS).count()) === 0)
    t.fail("кнопка первого экрана ведёт не к форме", href);
  const tb = await target.boundingBox();
  if (!tb || tb.y >= t.viewport.height || tb.y + tb.height <= 0)
    t.fail(
      "после нажатия кнопки форма не появилась на экране",
      tb ? `верх блока ${Math.round(tb.y)} px` : undefined,
    );
};

/** A small PNG «photo» of the owner (a warm gradient) for the upload of GS-landing-2. */
function ownerPng(width = 320, height = 240): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0, o = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = 200 + Math.round((x / width) * 50);
      raw[o++] = 120 + Math.round((y / height) * 60);
      raw[o++] = 80;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * GS-landing-2 (B2-38): the owner replaces a photo of the site in one click — «Фото сайта» in the cabinet, a file chosen
 * in the first place of the page — and the visitor sees the owner's picture there on «/».
 */
const ownerPhoto: GoalProgram = async (t) => {
  t.step("Владелец открывает «Фото сайта» в кабинете");
  await t.as("owner");
  await t.open("/cabinet/photos");
  const first = t.page.locator('[data-testid^="wz-site-photo-"]').first();
  if ((await first.count()) === 0) {
    await t.expectText("нет мест для фото");
    return;
  }
  const slot = ((await first.getAttribute("data-testid")) ?? "").replace("wz-site-photo-", "");
  t.step("Загружает своё фото для первого места страницы");
  const input = first.locator('input[type="file"]').first();
  if ((await input.count()) === 0) t.fail("у места для фото нет кнопки загрузки своего фото", slot);
  await input.setInputFiles({ name: "moe-foto.png", mimeType: "image/png", buffer: ownerPng() });
  let fileId = "";
  for (let i = 0; i < 40 && !fileId; i++) {
    const row = (await t.rows("site_photo")).find((r) => r.slot === slot);
    if (typeof row?.image === "string") fileId = row.image;
    else await t.page.waitForTimeout(250);
  }
  if (!fileId) t.fail("фото владельца не сохранилось за место на странице", slot);

  t.step("Посетитель открывает главную страницу");
  await t.as("visitor");
  await t.open("/");
  t.step("На этом месте — фото владельца");
  const img = t.page.locator(`img[src*="${fileId}"]`).first();
  if ((await img.count()) === 0) t.fail("на главной нет фото владельца", `место ${slot}`);
  await img.scrollIntoViewIfNeeded();
  // A lazy picture below the fold: load it now and wait until it is complete (≤ 8 s).
  const loaded = await img
    .evaluate(
      (el) =>
        new Promise<number>((done) => {
          const i = el as HTMLImageElement;
          i.loading = "eager";
          const until = Date.now() + 8000;
          const check = () =>
            (i.complete && i.naturalWidth > 0) || Date.now() > until
              ? done(i.naturalWidth)
              : setTimeout(check, 100);
          check();
        }),
    )
    .catch(() => 0);
  if (!loaded) t.fail("фото владельца на главной не загрузилось", `место ${slot}`);
};

export const LANDING_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-landing-1": heroAction,
  "GS-landing-2": ownerPhoto,
};
