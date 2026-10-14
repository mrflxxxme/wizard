// V3-18: the preview's demo rows from the brief, without a model — the names of the catalog's and the shop's items
// (and of their sections) the brief or the owner lists («показывает услуги: дизайн квартиры, …», «Мы мастерская из
// Твери: кружки, тарелки, …») go to the seed of the draft as hints (gates.generateSeed {hints}): the visitor of the
// preview sees the owner's own offer, never «Товар «Летний»». Nothing invented (D49): only names, in his words.
import type { AppSpec, BriefScenario, SystemBrief } from "@wizard/appspec";
import { SEED_HINT_MAX_VALUES, type SeedHint, validateSeedHint } from "@wizard/gates";
import { CATALOG_NAMES, SHOP_NAMES } from "@wizard/modules";
import { staffFacts } from "../../../interview-v3/place.js";
import { businessOf, offerOf, shownLists } from "./copy.js";

/** Entities whose rows are the offer (catalog items, booking services, shop products) and their sections. */
const ITEMS = [CATALOG_NAMES.item, SHOP_NAMES.product] as const;
const SECTIONS = [CATALOG_NAMES.category, SHOP_NAMES.category] as const;
const NAME = "name";

const PUBLIC_ACTORS: ReadonlySet<string> = new Set(["visitor", "client"]);
/** Scenarios of the offer: the catalog, the shop, the booking of a service. */
const OFFER_MODULES: ReadonlySet<string> = new Set(["catalog", "shop", "booking"]);
const OFFER_WHEN = /каталог|услуг|цен|товар|магазин|запис|ассортимент/i;
/** A list of sections, not of the items themselves. */
const SECTION_LIST = /^(?:раздел|категори|рубрик|направлени|групп)/i;
/** Lists that are not the offer: form fields, statuses, steps, the staff, contacts. */
const NOT_OFFER =
  /^(?:форм|пол[еяй]|статус|этап|шаг|контакт|врач|мастер|сотрудник|специалист|способ|вариант[ыа]? (?:оплат|доставк))/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A list of the staff in the owner's words («пять врачей: терапевт, два хирурга, ортодонт и детский стоматолог»). */
const STAFF_COLON = /(?:врач|специалист|мастер|сотрудник)\S*\s*:\s*([^.;]+)/giu;
/**
 * V4-20: the direction a specialist of the brief works in («хирург» → «Хирургия»): a clinic or a salon that lists its
 * staff, not its services, still shows the owner's own offer instead of «Услуга 1». Only what the brief names.
 */
const DIRECTIONS: readonly (readonly [RegExp, string])[] = [
  [/детск\S*\s+стоматолог/i, "Детская стоматология"],
  [/терапевт/i, "Терапия"],
  [/хирург/i, "Хирургия"],
  [/ортодонт/i, "Ортодонтия"],
  [/ортопед/i, "Ортопедия"],
  [/имплантолог/i, "Имплантация"],
  [/пародонтолог/i, "Пародонтология"],
  [/гигиенист/i, "Профессиональная гигиена"],
  [/педиатр/i, "Педиатрия"],
  [/гинеколог/i, "Гинекология"],
  [/кардиолог/i, "Кардиология"],
  [/невролог/i, "Неврология"],
  [/дерматолог/i, "Дерматология"],
  [/косметолог/i, "Косметология"],
  [/массажист/i, "Массаж"],
  [/визажист/i, "Макияж"],
  [/колорист/i, "Окрашивание волос"],
  [/парикмахер|стилист/i, "Стрижки и укладки"],
  [/маникюр/i, "Маникюр"],
  [/педикюр/i, "Педикюр"],
  [/бровист/i, "Оформление бровей"],
  [/логопед/i, "Логопедия"],
  [/психолог/i, "Консультации психолога"],
];

/** The directions of a staff list, in its order; null — fewer than two known. */
function directionsOf(items: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const item of items)
    for (const [re, name] of DIRECTIONS)
      if (re.test(item)) {
        if (!out.includes(name)) out.push(name);
        break;
      }
  return out.length >= 2 ? out : null;
}

/**
 * The staff of the owner's own words («пять врачей: терапевт, …») as directions of the offer. A list the brief shows
 * («показывает врачей: …») is the doctors' page, not the offer, and stays out.
 */
function staffDirections(request?: string | null): string[] | null {
  for (const m of (request ?? "").matchAll(STAFF_COLON)) {
    const d = directionsOf((m[1] as string).split(/,\s*|\s+и\s+/));
    if (d) return d;
  }
  return null;
}

/** Distinct values (case-insensitive), capitalised, at most SEED_HINT_MAX_VALUES. */
function names(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = cap(raw.replace(/\s+/g, " ").trim());
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.slice(0, SEED_HINT_MAX_VALUES);
}

/** The hint of entity.name with the values the generator takes (each checked alone: length, PII), or none. */
function hintOf(spec: AppSpec, entity: string, values: readonly string[]): SeedHint | null {
  const ok = values.filter((v) => validateSeedHint(spec, { entity, field: NAME, values: [v] }).length === 0);
  return ok.length ? { entity, field: NAME, values: ok } : null;
}

/**
 * Seed hints of the draft from the brief (deterministic, 0 ₽): the items its offer scenarios list, else the offer in
 * the owner's first words (`request`), as names of the catalog's / shop's items; a list of sections («показывает
 * разделы: …») as names of their sections. Entities the spec lacks get none; [] — the brief lists nothing.
 */
export function seedHintsFromBrief(
  spec: AppSpec,
  brief: Pick<SystemBrief, "scenarios"> & Partial<Pick<SystemBrief, "qa">>,
  request?: string | null,
): SeedHint[] {
  const offer = brief.scenarios.filter(
    (s: BriefScenario) =>
      PUBLIC_ACTORS.has(s.actor) && (OFFER_MODULES.has(s.moduleHint ?? "") || OFFER_WHEN.test(s.when)),
  );
  const lists = shownLists(offer.flatMap((s) => s.then)).filter((l) => !NOT_OFFER.test(l.what));
  const sections = lists.find((l) => SECTION_LIST.test(l.what))?.items ?? null;
  const items =
    lists.find((l) => !SECTION_LIST.test(l.what))?.items ??
    (request ? offerOf(request, businessOf(request)) : null) ??
    staffDirections(request) ??
    // V4-24: the specialists the owner named in the interview («Анна Смирнова — терапевт»), as directions.
    directionsOf(staffFacts({ qa: brief.qa ?? [] }));
  const has = new Set(spec.entities.map((e) => e.name));
  const out: SeedHint[] = [];
  for (const [entities, list] of [
    [ITEMS, items],
    [SECTIONS, sections],
  ] as const) {
    if (!list?.length) continue;
    for (const entity of entities) {
      if (!has.has(entity)) continue;
      const h = hintOf(spec, entity, names(list));
      if (h) out.push(h);
    }
  }
  out.push(...specialistHints(spec, brief.qa ?? []));
  return out;
}

/** The booking's specialists (with_specialists): their names and what each does. */
const SPECIALIST = { entity: "specialist", name: "name", role: "description" } as const;

/**
 * V4-24, D79 (3): the specialists the owner named in the interview («Анна Смирнова — терапевт») as the demo rows of the
 * booking's specialists — the name as he wrote it (source "owner": a person's name passes the seed's DLP, nothing else
 * does), the specialisation as the description. No photos of people. [] — no such entity or no names given.
 */
function specialistHints(spec: AppSpec, qa: SystemBrief["qa"]): SeedHint[] {
  if (!spec.entities.some((e) => e.name === SPECIALIST.entity)) return [];
  const people = staffFacts({ qa })
    .map((x) => {
      const [name, ...role] = x.split(/\s+[—–-]\s+/);
      return { name: (name ?? "").trim(), role: role.join(" — ").trim() };
    })
    .filter(
      (p) =>
        p.name &&
        validateSeedHint(spec, {
          entity: SPECIALIST.entity,
          field: SPECIALIST.name,
          values: [p.name],
          source: "owner",
        }).length === 0,
    )
    .slice(0, SEED_HINT_MAX_VALUES);
  if (!people.length) return [];
  const out: SeedHint[] = [
    { entity: SPECIALIST.entity, field: SPECIALIST.name, values: people.map((p) => p.name), source: "owner" },
  ];
  // The descriptions only while each person has one: values[i] goes to row i.
  const roles: string[] = [];
  for (const p of people) {
    if (!p.role) break;
    roles.push(cap(p.role));
  }
  const h = { entity: SPECIALIST.entity, field: SPECIALIST.role, values: roles };
  if (roles.length && validateSeedHint(spec, h).length === 0) out.push(h);
  return out;
}
