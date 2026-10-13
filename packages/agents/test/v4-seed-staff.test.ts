// V4-20: a brief that lists the staff, not the services (the clinic of the V4 acceptance: «пять врачей: терапевт, два
// хирурга, ортодонт и детский стоматолог»), still gives the preview the owner's own offer — the directions of the
// specialists it names — instead of «Услуга 1»; nothing beyond what it names, no prices.
import { systemBriefSchema } from "@wizard/appspec";
import { generateSeed, placeholderOf, seedDlp } from "@wizard/gates";
import { expect, test } from "vitest";
import { seedHintsFromBrief } from "../src/builder/index.js";
import { briefSite } from "./v3-brief-site.js";
import { DENTAL_BOOKING } from "./v3-eval-briefs.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const REQUEST =
  "Стоматологическая клиника в Казани, пять врачей: терапевт, два хирурга, ортодонт и детский стоматолог. Хотим, чтобы пациенты записывались к врачам онлайн.";
const DIRECTIONS = ["Терапия", "Хирургия", "Ортодонтия", "Детская стоматология"];

test("the clinic's specialists name its services; the seed has no «Услуга N»", async () => {
  const { spec } = await briefSite("v3-02-dental-booking", DENTAL_BOOKING, { request: REQUEST });
  const brief = systemBriefSchema.parse(DENTAL_BOOKING);
  const hints = seedHintsFromBrief(spec, brief, REQUEST);
  expect(hints).toContainEqual({ entity: "service", field: "name", values: DIRECTIONS });
  const seed = generateSeed(spec, "key-1", { now: NOW, hints, showcase: true });
  const names = (seed.rows.service ?? []).map((r) => String(r.name));
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) {
    expect(DIRECTIONS).toContain(n);
    expect(placeholderOf(n), n).toBeNull();
  }
  expect(seedDlp(spec, seed)).toEqual([]);
});

test("a staff list of unknown specialists or of one gives nothing", async () => {
  const { spec } = await briefSite("v3-02-dental-booking", DENTAL_BOOKING, { request: REQUEST });
  const brief = systemBriefSchema.parse(DENTAL_BOOKING);
  expect(seedHintsFromBrief(spec, brief, "Клиника, два врача: терапевт и главный врач.")).toEqual([]);
  expect(seedHintsFromBrief(spec, brief, "Клиника, врачи: Иванова, Петров.")).toEqual([]);
});
