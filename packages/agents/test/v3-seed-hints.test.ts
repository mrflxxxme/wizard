// V3-18: the preview's demo rows from the brief — seedHintsFromBrief gives the names of the offer the brief (else the
// owner's first words) lists to the seed of the draft; the seed of the composed backend shows them instead of
// template names, with no invented descriptions; a brief that lists nothing gives no hints.
import { type AppSpec, systemBriefSchema } from "@wizard/appspec";
import { generateSeed, seedDlp } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import { seedHintsFromBrief } from "../src/builder/index.js";
import { briefSite } from "./v3-brief-site.js";
import { CERAMICS_SHOP, DENTAL_BOOKING, INTERIOR_STUDIO } from "./v3-eval-briefs.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const TEMPLATE = /«(Основной|Пробный|Весенний|Базовый|Расширенный|Летний|Новый|Особый)»|Популярный вариант/;

describe("seedHintsFromBrief", () => {
  test("the services the catalog scenario lists name the catalog's items of the interior studio", async () => {
    const { spec } = await briefSite("v3-01-interior-studio", INTERIOR_STUDIO);
    const brief = systemBriefSchema.parse(INTERIOR_STUDIO);
    const hints = seedHintsFromBrief(spec, brief);
    expect(hints).toEqual([
      {
        entity: "service",
        field: "name",
        values: ["Дизайн квартиры", "Дизайн дома", "Авторский надзор", "Комплектация"],
      },
    ]);
    const seed = generateSeed(spec, "key-1", { now: NOW, hints });
    expect((seed.rows.service ?? []).slice(0, 3).map((r) => r.name)).toEqual([
      "Дизайн квартиры",
      "Дизайн дома",
      "Авторский надзор",
    ]);
    for (const r of seed.rows.service ?? []) expect(r.description).toBeUndefined();
    expect(JSON.stringify(seed.rows)).not.toMatch(TEMPLATE);
    expect(seedDlp(spec, seed)).toEqual([]);
  });

  test("the shop's products from the owner's first words when the brief lists none (ceramics)", async () => {
    const request =
      "Мы мастерская из Твери: кружки, тарелки, вазы ручной работы, многие вещи в одном экземпляре.";
    const { spec } = await briefSite("v3-05-ceramics-shop", CERAMICS_SHOP, { request });
    const brief = systemBriefSchema.parse(CERAMICS_SHOP);
    const hints = seedHintsFromBrief(spec, brief, request);
    expect(hints).toContainEqual({
      entity: "product",
      field: "name",
      values: ["Кружки", "Тарелки", "Вазы ручной работы"],
    });
    const seed = generateSeed(spec, "key-1", { now: NOW, hints });
    expect((seed.rows.product ?? []).map((r) => r.name).slice(0, 3)).toEqual([
      "Кружки",
      "Тарелки",
      "Вазы ручной работы",
    ]);
    expect(JSON.stringify(seed.rows)).not.toMatch(TEMPLATE);
    expect(seedDlp(spec, seed)).toEqual([]);
    // Without the owner's words the brief lists nothing: no hints, the seed's neutral names.
    expect(seedHintsFromBrief(spec, brief)).toEqual([]);
  });

  test("a brief without a list gives no hints; its seed has neutral names and booking durations", async () => {
    const { spec } = await briefSite("v3-02-dental-booking", DENTAL_BOOKING, { request: null });
    expect(seedHintsFromBrief(spec, systemBriefSchema.parse(DENTAL_BOOKING))).toEqual([]);
    const seed = generateSeed(spec, "key-1", { now: NOW });
    expect(JSON.stringify(seed.rows)).not.toMatch(TEMPLATE);
    for (const r of seed.rows.service ?? []) {
      expect(String(r.name)).not.toMatch(/«/);
      if (r.duration_min !== undefined) expect([30, 60, 90, 120]).toContain(r.duration_min);
    }
  });

  test("sections listed apart, form fields and staff lists ignored, entities the spec lacks skipped", () => {
    const entity = (name: string) => ({
      name,
      label: name,
      fields: [{ name: "name", label: "Название", type: "string", required: true, maxLength: 20 }],
    });
    const spec = {
      entities: [entity("service"), entity("service_category")],
    } as unknown as AppSpec;
    const step = (then: string[]) => ({
      scenarios: [
        {
          id: "s",
          actor: "visitor" as const,
          priority: "must" as const,
          when: "посетитель смотрит каталог",
          then,
        },
      ],
    });
    expect(
      seedHintsFromBrief(
        spec,
        step([
          "показывает форму: имя, телефон",
          "показывает разделы: стрижки, окрашивание",
          "показывает услуги: стрижка, укладка, очень длинное название услуги салона",
        ]),
      ),
    ).toEqual([
      // A value over the field's maxLength is dropped alone, the rest of the list stays.
      { entity: "service", field: "name", values: ["Стрижка", "Укладка"] },
      { entity: "service_category", field: "name", values: ["Стрижки", "Окрашивание"] },
    ]);
    expect(seedHintsFromBrief(spec, step(["показывает врачей: терапевт, ортодонт"]))).toEqual([]);
    // Personal data never becomes a hint.
    expect(
      seedHintsFromBrief(spec, step(["показывает услуги: звоните +79123456789, укладка"]))[0]?.values,
    ).toEqual(["Укладка"]);
  });
});
