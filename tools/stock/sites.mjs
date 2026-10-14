#!/usr/bin/env node
// V4-28: the photo probe of the acceptance sites without a build (stock-library.yml, action sites). For each brief —
// the coffee house v3-13 and the beauty salon v3-14, or --set=survey: niches of every large group — the photos of the site's places (semanticPhotos with the live
// photo_pick, as the build's vision pick), then the catalog cards (V4-27: the rows the brief names, one photo_pick
// check over two candidates a row). Prints one line per photo (place, library id, stock source, the niche shard it came
// from, the stock query it was filled by) and writes the 480 px copies into --out for the artifact, so a person sees
// what the site would show: foreign signs, another niche, the same photo twice, people close up who would pass for the
// staff. Env: the storage as for fill.mjs (WIZARD_FILES_STORAGE=s3, WIZARD_S3_*) and the vision model keys
// (ZAI_API_KEY, KIMI_API_KEY); every printed line passes through scrubKeys.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { annotation, registerTsx, scrubKeys } from "../deploy/stock-ci.mjs";
import { storageEnv } from "./fill.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const TITLE = "Фото сайтов приёмки";

/** The acceptance sites: the niche as the plan names it and the card rows the brief lists. */
export const SITES = [
  {
    id: "v3-13-coffee-house",
    niche: "кофейня",
    entity: "menu_item",
    rows: ["Эспрессо и кофе с молоком", "Альтернатива", "Десерты", "Завтраки"],
  },
  {
    id: "v3-14-beauty-salon",
    niche: "салон красоты",
    entity: "service",
    rows: ["Стрижки и окрашивание", "Маникюр и педикюр", "Брови и ресницы"],
  },
];

/** A landing with every photo place (first screen, «О нас», features, gallery), as the planner makes it. */
/**
 * The survey of the library (--set=survey, or a comma list of their ids): two or three niches of every large group —
 * food, beauty, medicine, services at home, education — each with the catalog rows a brief of the niche would list.
 */
export const SURVEY = [
  { id: "bakery", niche: "пекарня", entity: "product", rows: ["Хлеб", "Круассаны", "Торты на заказ"] },
  { id: "pizza", niche: "пиццерия", entity: "menu_item", rows: ["Маргарита", "Пепперони", "Десерты"] },
  { id: "sushi", niche: "суши и роллы", entity: "menu_item", rows: ["Роллы", "Сеты", "Супы"] },
  { id: "barber", niche: "барбершоп", entity: "service", rows: ["Мужская стрижка", "Борода", "Детская стрижка"] },
  { id: "nails", niche: "маникюр и педикюр", entity: "service", rows: ["Маникюр", "Педикюр", "Наращивание"] },
  { id: "massage", niche: "массаж", entity: "service", rows: ["Классический массаж", "Спортивный массаж", "Массаж лица"] },
  { id: "vet", niche: "ветеринарная клиника", entity: "service", rows: ["Приём терапевта", "Вакцинация", "Стерилизация"] },
  { id: "psy", niche: "психолог", entity: "service", rows: ["Консультация", "Семейная терапия", "Онлайн-сессия"] },
  { id: "optics", niche: "оптика", entity: "service", rows: ["Проверка зрения", "Очки", "Контактные линзы"] },
  { id: "cleaning", niche: "клининг", entity: "service", rows: ["Генеральная уборка", "Мытьё окон", "Уборка после ремонта"] },
  { id: "plumber", niche: "сантехник", entity: "service", rows: ["Замена смесителя", "Прочистка труб", "Установка унитаза"] },
  { id: "repair", niche: "ремонт квартир", entity: "service", rows: ["Косметический ремонт", "Плитка", "Электрика"] },
  { id: "dance", niche: "школа танцев", entity: "service", rows: ["Сальса", "Хип-хоп", "Танцы для детей"] },
  { id: "english", niche: "курсы иностранных языков", entity: "service", rows: ["Английский для взрослых", "Английский для детей", "Разговорный клуб"] },
  { id: "driving", niche: "автошкола", entity: "service", rows: ["Категория B", "Вождение с инструктором", "Теория"] },
];

/** The sites of a run: the acceptance ones by default, the survey, or the survey niches named. */
export function sitesOf(set) {
  if (!set || set === "acceptance") return SITES;
  if (set === "survey") return SURVEY;
  const ids = new Set(set.split(",").map((x) => x.trim()));
  return [...SITES, ...SURVEY].filter((x) => ids.has(x.id));
}

const planOf = (niche) => ({
  version: 1,
  niche,
  goals: [{ id: "leads", statement: "Получать заявки с сайта" }],
  modules: [{ id: "landing" }, { id: "leads" }, { id: "notify" }],
  landing: {
    sections: [
      { type: "header", variant: "bar", content: {} },
      { type: "hero", variant: "split", content: { title: "Заголовок", cta: "Записаться" } },
      { type: "about", variant: "split", content: { title: "О нас", text: "Текст." } },
      { type: "features", variant: "alternating", content: { title: "Почему мы", items: ["Один", "Два", "Три"] } },
      { type: "gallery", variant: "grid", content: { title: "Работы", items: ["Один", "Два", "Три"] } },
      { type: "lead_form", variant: "card", content: { title: "Оставьте заявку" } },
      { type: "footer", variant: "simple", content: {} },
    ],
  },
  design: { direction: { mood: ["тепло"] }, theme: "warm", accent: "#8A5A3C", fontPair: { heading: "Onest", body: "Onest" } },
  outOfScope: [],
  custom: [],
});

/** The minimal spec of a catalog: one public entity with a name and a photo. */
const specOf = (site) => ({
  app: { name: site.niche },
  roles: [{ name: "visitor", access: "public" }],
  entities: [
    {
      name: site.entity,
      fields: [
        { name: "name", type: "string" },
        { name: "photo", type: "image" },
      ],
    },
  ],
  permissions: [{ role: "visitor", entity: site.entity, ops: ["read"] }],
});

const argOf = (argv, name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

/** CLI; returns the exit code (0 — done, a problem of one site is a warning). */
export async function main(argv, { env = process.env, log = console.log } = {}) {
  const secrets = {
    zai: env.ZAI_API_KEY,
    kimi: env.KIMI_API_KEY,
    s3id: env.WIZARD_S3_ACCESS_KEY_ID,
    s3secret: env.WIZARD_S3_SECRET_ACCESS_KEY,
  };
  const out = (line) => log(scrubKeys(line, secrets));
  const dir = argOf(argv, "out") ?? join(env.RUNNER_TEMP || join(ROOT, ".data"), "site-photos");
  const senv = await storageEnv(env);
  await registerTsx();
  const at = (p) => import(pathToFileURL(join(ROOT, p)).href);
  const [S, rtStorage, rtLibrary, M, L, C] = await Promise.all([
    at("packages/agents/src/stock/index.ts"),
    at("apps/runtime/src/files/storage.ts"),
    at("apps/runtime/src/files/photo-library.ts"),
    at("packages/modules/src/index.ts"),
    at("packages/llm/src/index.ts"),
    at("apps/platform-api/src/builds-v3/card-photos.ts"),
  ]);
  const storage = rtStorage.createFileStorage(senv, { defaultDir: join(ROOT, ".data", "files") });
  const thumb = async (file) => (await rtLibrary.libraryPhotoFile(storage, file, 480))?.body ?? null;
  const source = S.createSemanticSource({
    objects: S.storageObjects(storage, (name) => `${rtLibrary.PHOTO_LIBRARY_PREFIX}/${rtLibrary.libraryPhotoId(name)}`),
    modelDir: join(env.RUNNER_TEMP || join(ROOT, ".data"), "siglip"),
    thumbnail: thumb,
  });
  const sink = new L.MemoryUsageSink();
  const router = L.createRouter({ mode: "live", registry: L.createRegistry({ buildDefaultTier: "T1" }), sink });
  const picker = (stepName) =>
    S.modelPhotoPicker({
      route: (i) => router.route(i),
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: "00000000-0000-4000-8000-0000000000f5" },
      stepName,
    });
  // Every library entry by id (the niche shard and the stock query of a picked photo).
  const lib = await S.loadSemanticLibrary(S.storageObjects(storage, (n) => `${rtLibrary.PHOTO_LIBRARY_PREFIX}/${rtLibrary.libraryPhotoId(n)}`));
  const entryOf = new Map((lib?.entries ?? []).map((e) => [e.file, e]));
  const lines = [];
  const save = async (site, place, file) => {
    const e = entryOf.get(file);
    const body = await thumb(file);
    const name = `${place.replace(/[^a-z0-9а-яё-]+/gi, "_")}.webp`;
    if (body) {
      mkdirSync(join(dir, site), { recursive: true });
      writeFileSync(join(dir, site, name), body);
    }
    lines.push(
      `| ${site} | ${place} | ${file.slice(0, 8)} | ${e?.niche ?? "?"} | ${e?.query ?? "?"} | ${e ? `${e.provider}:${e.id}` : "?"} | ${body ? name : "—"} |`,
    );
  };
  for (const site of sitesOf(argOf(argv, "set"))) {
    try {
      const t0 = Date.now();
      const plan = planOf(site.niche);
      const slots = M.photoSlots(plan, 6);
      const r = await S.semanticPhotos({ plan, slots, source, picker: picker("photo_pick"), pickedAt: "2026-10-14" });
      for (const p of r.photos) await save(site.id, p.slot, p.file);
      const used = new Set(r.photos.map((p) => p.file));
      const names = [{ entity: site.entity, field: "name", values: site.rows }];
      // The model's answer of the card check, as it came (slot → candidate, text), for the report.
      const cardPicker = picker("photo_cards");
      const check = C.pickerCardCheck({
        picker: async (input) => {
          const a = await cardPicker(input);
          const name = (i) => input.candidates[i]?.entry.file.slice(0, 8) ?? "?";
          out(
            `${site.id} photo_cards: кандидатов ${input.candidates.length}; ответ: ${
              a ? a.map((x) => ("slot" in x ? `${x.slot}=${name(x.index)}` : `text=${name(x.text)}`)).join(", ") || "пусто" : "сбой"
            }`,
          );
          return a;
        },
        niche: site.niche,
        source,
      });
      const hints = await C.semanticSeedHints(specOf(site), names, used, new Set(), source, { niche: site.niche, check });
      const cards = hints.find((h) => h.field === "photo")?.values ?? [];
      for (const [i, v] of cards.entries()) await save(site.id, `card-${i + 1} ${site.rows[i] ?? ""}`, v.split("/")[3]);
      const dup = cards.length - new Set(cards).size;
      out(
        annotation(
          "notice",
          TITLE,
          `${site.id}: мест ${slots.length}, фото ${r.photos.length} (${r.picked ? "выбрала модель" : "по сходству"}), карточек ${cards.length} из ${site.rows.length}, повторов ${dup}; ${Math.round((Date.now() - t0) / 1000)} с`,
        ),
      );
    } catch (e) {
      out(annotation("warning", TITLE, `${site.id}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  const rub = sink.records.reduce((s, x) => s + x.costRub, 0);
  const table = `## ${TITLE}\n\nИтого ${rub.toFixed(2)} ₽, вызовов ${sink.records.length}\n\n| Сайт | Место | Фото | Шард | Запрос стока | Источник | Файл |\n|---|---|---|---|---|---|---|\n${lines.join("\n")}\n`;
  out(table);
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(env.GITHUB_STEP_SUMMARY, scrubKeys(table, secrets));
  }
  await source.close?.();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).then((code) => process.exit(code));
