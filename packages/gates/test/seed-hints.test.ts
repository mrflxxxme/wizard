// M1-09: QA seed hints (qa.yaml#seed.rules MAY) — validated, positional (values[i] → row i), pii=none only, DLP-clean;
// invalid hints never reach the seed; scenarios with invalid hints fail static validation.
import { describe, expect, test } from "vitest";
import {
  generateSeed,
  mergeSeedHints,
  type Scenario,
  type SeedHint,
  seedDlp,
  validateScenario,
  validateSeedHint,
} from "../src/index.js";
import { loadForum } from "./helpers.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const spec = loadForum();
const ok: SeedHint[] = [
  { entity: "stream", field: "name", values: ["Большой зал", "Малый зал"] },
  { entity: "ticket_type", field: "kind", values: ["vip"] },
  { entity: "ticket_type", field: "active", values: [true, true, true] },
  { entity: "stream", field: "capacity", values: [500] },
];

describe("validateSeedHint", () => {
  test("accepts plausible non-personal values of pii=none fields", () => {
    for (const h of ok) expect(validateSeedHint(spec, h), JSON.stringify(h)).toEqual([]);
  });

  test.each<[string, SeedHint, string]>([
    ["unknown entity", { entity: "nope", field: "x", values: ["a"] }, "нет сущности"],
    ["unknown field", { entity: "stream", field: "nope", values: ["a"] }, "нет поля"],
    ["pii field", { entity: "ticket", field: "holder_name", values: ["Анна Тестова"] }, "персональными"],
    ["unique field", { entity: "partner_quota", field: "promo_code", values: ["PROMO"] }, "уникальное"],
    ["ref field", { entity: "ticket", field: "stream", values: ["x"] }, "только для полей"],
    ["enum outside", { entity: "ticket_type", field: "kind", values: ["gold"] }, "нет в enum"],
    ["string for int", { entity: "stream", field: "capacity", values: ["10"] }, "целое"],
    ["money not ×100", { entity: "ticket_type", field: "price", values: [150] }, "кратная 100"],
    [
      "phone in text",
      { entity: "stream", field: "description", values: ["Звоните +7 912 345-67-89"] },
      "SEED_PII",
    ],
    [
      "too many",
      { entity: "stream", field: "name", values: Array.from({ length: 11 }, (_, i) => `З${i}`) },
      "от 1 до 10",
    ],
  ])("%s → error", (_n, h, msg) => {
    expect(validateSeedHint(spec, h).join(" ")).toContain(msg);
  });
});

describe("generateSeed with hints", () => {
  const plain = generateSeed(spec, "k", { now: NOW });
  const hinted = generateSeed(spec, "k", { now: NOW, hints: ok });

  test("values[i] lands in row i; rows past the hint keep generator values; ids are unchanged", () => {
    expect(plain.rows.stream?.[0]?.name).not.toBe("Большой зал");
    expect(hinted.rows.stream?.map((r) => r.name).slice(0, 2)).toEqual(["Большой зал", "Малый зал"]);
    expect(hinted.rows.stream?.[2]?.name).toBe(plain.rows.stream?.[2]?.name);
    expect(hinted.rows.stream?.[0]?.capacity).toBe(500);
    expect(hinted.rows.ticket_type?.[0]?.kind).toBe("vip");
    expect(hinted.rows.ticket_type?.slice(0, 3).map((r) => r.active)).toEqual([true, true, true]);
    expect(hinted.rows.stream?.map((r) => r.id)).toEqual(plain.rows.stream?.map((r) => r.id));
    expect(seedDlp(spec, hinted)).toEqual([]);
  });

  test("invalid hints are ignored; the first hint wins per row, later ones fill the gaps", () => {
    const bad: SeedHint[] = [
      { entity: "ticket", field: "holder_name", values: ["Пётр Настоящий"] },
      { entity: "stream", field: "description", values: ["Звоните +7 912 345-67-89"] },
    ];
    expect(generateSeed(spec, "k", { now: NOW, hints: bad })).toEqual(plain);
    const merged = mergeSeedHints(spec, [
      { entity: "stream", field: "name", values: ["А-зал"] },
      { entity: "stream", field: "name", values: ["Б-зал", "В-зал"] },
    ]);
    expect(merged.get("stream.name")).toEqual(["А-зал", "В-зал"]);
  });
});

describe("validateScenario", () => {
  const base: Scenario = {
    id: "SC-AC1-9",
    acId: "AC1",
    title: "Поток из seed",
    actors: { org: { role: "organizer" } },
    steps: [
      { as: "org" },
      { read: { entity: "stream", id: "$seed.stream[0].id" } },
      { expect: { status: "ok" } },
    ],
  };

  test("valid hints pass, invalid ones are scenario errors (QA repeats with them)", () => {
    expect(validateScenario(spec, { ...base, seedHints: ok })).toEqual([]);
    const errs = validateScenario(spec, {
      ...base,
      seedHints: [{ entity: "ticket", field: "holder_email", values: ["user1@example.test"] }],
    });
    expect(errs.join()).toContain("seedHints ticket.holder_email");
  });
});
