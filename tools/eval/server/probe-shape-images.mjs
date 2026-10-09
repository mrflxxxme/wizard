#!/usr/bin/env node
// V3-18: the synthetic screenshots of the shape probe (tools/eval/server/probe-shape.mjs) — six JPEGs of the critic's
// shot plan (packages/agents critic/hook.ts shotPlan: 390×844, 768 → 384×512, 1440 → 720×450, the whole page at 1440
// → 360×2400, two more pages at 390×844), made like the platform makes them (apps/platform-api builds-v3/critic.ts
// shrink: a PNG screenshot downscaled on a canvas of the same browser, JPEG quality 0.6). The page is a made-up landing
// page: no client data, nothing from any system. Run once (the JSON is committed; the probe test checks its sizes):
//   node tools/eval/server/probe-shape-images.mjs
// Chromium of the workspace's Playwright (packages/e2e), PLAYWRIGHT_BROWSERS_PATH as configured on the machine.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./screenshots.mjs";

/** Where the images go (read by probe-shape.mjs). */
export const SHAPE_IMAGES_FILE = fileURLToPath(new URL("./probe-shape-images.json", import.meta.url));
/** JPEG quality of the platform's critic screenshots (builds-v3/critic.ts JPEG_QUALITY). */
export const SHAPE_JPEG_QUALITY = 0.6;

/** The shot plan of a three-page site (critic/hook.ts shotPlan) with the viewport heights of builds-v3/critic.ts. */
export const SHAPE_SHOTS = [
  { route: "/", width: 390, height: 844, kind: "screen", maxWidth: 390, maxHeight: 844 },
  { route: "/", width: 768, height: 1024, kind: "screen", maxWidth: 384, maxHeight: 512 },
  { route: "/", width: 1440, height: 900, kind: "screen", maxWidth: 720, maxHeight: 450 },
  { route: "/", width: 1440, height: 900, kind: "page", maxWidth: 360, maxHeight: 2400 },
  { route: "/services", width: 390, height: 844, kind: "screen", maxWidth: 390, maxHeight: 844 },
  { route: "/contacts", width: 390, height: 844, kind: "screen", maxWidth: 390, maxHeight: 844 },
];

const CSS = `
*{box-sizing:border-box;margin:0}body{font-family:Georgia,"DejaVu Serif",serif;color:#1f2a2e;background:#f6f3ee}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 6vw;background:#fffaf2;border-bottom:1px solid #e3d9c8}
header b{font-size:22px;letter-spacing:.5px}nav a{margin-left:22px;color:#5b4a36;text-decoration:none;font-family:Arial,sans-serif;font-size:15px}
section{padding:72px 6vw;min-height:960px}h1{font-size:clamp(34px,6vw,72px);line-height:1.05;margin-bottom:22px}
h2{font-size:clamp(26px,3.6vw,44px);margin-bottom:26px}p{font-family:Arial,sans-serif;font-size:18px;line-height:1.55;max-width:640px;margin-bottom:14px;color:#3c4a50}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:40px;align-items:center;background:linear-gradient(160deg,#fffaf2,#efe4d2)}
.photo{min-height:420px;border-radius:22px;background:radial-gradient(circle at 30% 30%,#d9b98c,transparent 55%),radial-gradient(circle at 70% 60%,#7f9c8f,transparent 50%),linear-gradient(135deg,#c4a07a,#58705f);filter:url(#grain)}
.btn{display:inline-block;margin-top:18px;padding:16px 28px;border-radius:999px;background:#2f4f46;color:#fff;font-family:Arial,sans-serif;font-size:17px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:22px}
.card{background:#fff;border-radius:18px;padding:26px;box-shadow:0 8px 30px rgba(40,30,20,.08)}
.card .photo{min-height:180px;margin-bottom:18px}.price{display:flex;justify-content:space-between;border-bottom:1px dashed #cdbfa8;padding:14px 0;font-family:Arial,sans-serif;font-size:18px}
.dark{background:#22312d;color:#f3ede2}.dark p{color:#cfd8d2}form{display:grid;gap:14px;max-width:520px}
input{padding:16px;border-radius:12px;border:1px solid #c9bba5;font-size:17px}footer{padding:48px 6vw;background:#1a2421;color:#b9c4bf;font-family:Arial,sans-serif;min-height:320px}
`;

const lorem = [
  "Работаем по записи, без очередей: выберите удобное время, и мы подтвердим его в течение часа.",
  "Каждый заказ ведёт один мастер — от первого звонка до результата, который можно потрогать руками.",
  "Цены фиксируем заранее и не меняем по ходу работы. Материалы показываем до начала.",
  "Гарантия на всё, что сделали, — двенадцать месяцев. Если что-то пошло не так, приедем бесплатно.",
];
const card = (t, i) =>
  `<div class="card"><div class="photo" style="filter:hue-rotate(${i * 40}deg) url(#grain)"></div><h3>${t}</h3><p>${lorem[i % lorem.length]}</p></div>`;

/** The made-up three-page site: a long home page, a catalog page, a contacts page. */
export function syntheticPage(route) {
  const grain =
    '<svg width="0" height="0" style="position:absolute"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" result="n"/><feColorMatrix type="saturate" values="0"/><feBlend in="SourceGraphic" mode="multiply"/></filter></svg>';
  const header =
    "<header><b>Мастерская «Пример»</b><nav><a>Услуги</a><a>Цены</a><a>Отзывы</a><a>Контакты</a></nav></header>";
  const footer =
    "<footer><p>Мастерская «Пример» · ежедневно с 9 до 21 · условный адрес, условный телефон</p><p>Сайт-пример для проверки формы запроса к моделям.</p></footer>";
  const body =
    route === "/"
      ? [
          `<section class="hero"><div><h1>Ремонт, который не стыдно показать гостям</h1><p>${lorem[0]}</p><p>${lorem[1]}</p><span class="btn">Оставить заявку</span></div><div class="photo"></div></section>`,
          `<section><h2>Что мы делаем</h2><div class="cards">${["Кухни", "Ванные", "Спальни", "Балконы", "Прихожие", "Детские"].map(card).join("")}</div></section>`,
          `<section class="dark"><h2>Как идёт работа</h2>${lorem.map((t, i) => `<p><b>${i + 1}.</b> ${t}</p>`).join("")}<div class="photo" style="margin-top:30px"></div></section>`,
          `<section><h2>Цены</h2>${["Замер", "Проект", "Демонтаж", "Отделка", "Сборка мебели", "Уборка"].map((t, i) => `<div class="price"><span>${t}</span><span>от ${(i + 1) * 1500} ₽</span></div>`).join("")}</section>`,
          `<section><h2>Отзывы</h2><div class="cards">${["Анна", "Олег", "Мария"].map((n, i) => `<div class="card"><h3>${n}</h3><p>${lorem[(i + 2) % lorem.length]}</p></div>`).join("")}</div></section>`,
          `<section class="hero"><div class="photo"></div><div><h2>Покажем похожие работы</h2><p>${lorem[2]}</p><span class="btn">Смотреть работы</span></div></section>`,
          `<section class="dark"><h2>Вопросы и ответы</h2>${lorem.map((t) => `<p>— ${t}</p>`).join("")}</section>`,
          `<section><h2>Оставьте заявку</h2><form><input placeholder="Имя"><input placeholder="Телефон"><input placeholder="Что нужно сделать"><span class="btn">Отправить заявку</span></form></section>`,
          `<section class="hero"><div><h2>Работаем по всему району</h2><p>${lorem[3]}</p></div><div class="photo"></div></section>`,
          `<section><h2>Гарантия</h2><p>${lorem[3]}</p><p>${lorem[2]}</p></section>`,
        ]
      : route === "/services"
        ? [
            `<section class="hero"><div><h1>Услуги и цены</h1><p>${lorem[2]}</p></div><div class="photo"></div></section>`,
            `<section><div class="cards">${["Кухни", "Ванные", "Спальни", "Балконы"].map(card).join("")}</div></section>`,
          ]
        : [
            `<section class="dark"><h1>Контакты</h1><p>${lorem[0]}</p><span class="btn">Позвонить</span><div class="photo" style="margin-top:30px"></div></section>`,
          ];
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${grain}${header}${body.join("")}${footer}</body></html>`;
}

/** The same shrink as builds-v3/critic.ts: downscale to maxWidth, cut to maxHeight, JPEG on a canvas. */
async function shrink(blank, png, maxWidth, maxHeight) {
  return blank.evaluate(
    async ({ b64, maxWidth, maxHeight, quality }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const scale = Math.min(1, maxWidth / bmp.width);
      const width = Math.round(bmp.width * scale);
      const height = Math.min(maxHeight, Math.round(bmp.height * scale));
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.fillStyle = "#fff";
      g.fillRect(0, 0, width, height);
      g.drawImage(bmp, 0, 0, Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      const url = c.toDataURL("image/jpeg", quality);
      return { data: url.slice(url.indexOf(",") + 1), width, height };
    },
    { b64: png.toString("base64"), maxWidth, maxHeight, quality: SHAPE_JPEG_QUALITY },
  );
}

/** The six JPEGs of the shot plan: [{name, route, width, kind, mime, px, bytes, data}]. */
export async function makeShapeImages(launch = launchChromium) {
  const browser = await launch();
  try {
    const blank = await browser.newPage();
    const out = [];
    for (const [i, s] of SHAPE_SHOTS.entries()) {
      const context = await browser.newContext({ viewport: { width: s.width, height: s.height } });
      try {
        const page = await context.newPage();
        await page.setContent(syntheticPage(s.route), { waitUntil: "load" });
        const full = s.kind === "page";
        const scale = Math.min(1, s.maxWidth / s.width);
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        const cssHeight = full ? Math.min(pageHeight, Math.ceil(s.maxHeight / scale)) : s.height;
        const png = await page.screenshot({
          type: "png",
          fullPage: full,
          ...(full ? { clip: { x: 0, y: 0, width: s.width, height: cssHeight } } : {}),
          animations: "disabled",
        });
        const img = await shrink(blank, png, s.maxWidth, s.maxHeight);
        out.push({
          name: `${i + 1}-${s.width}-${s.kind}.jpg`,
          route: s.route,
          width: s.width,
          kind: s.kind,
          mime: "image/jpeg",
          px: { width: img.width, height: img.height },
          bytes: Buffer.from(img.data, "base64").length,
          data: img.data,
        });
      } finally {
        await context.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const images = await makeShapeImages();
  writeFileSync(
    SHAPE_IMAGES_FILE,
    `${JSON.stringify(
      {
        v: 1,
        source: "tools/eval/server/probe-shape-images.mjs",
        note: "Синтетические снимки выдуманного сайта (не система клиента) в размерах плана снимков критика, JPEG 0.6.",
        quality: SHAPE_JPEG_QUALITY,
        images,
      },
      null,
      1,
    )}\n`,
  );
  for (const im of images) console.log(`${im.name}: ${im.px.width}×${im.px.height}, ${im.bytes} байт`);
  console.log(`всего ${images.reduce((s, x) => s + x.data.length, 0)} символов base64`);
}
