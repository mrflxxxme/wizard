// V3-18: the preview's demo rows from the brief, without a model — the names of the catalog's and the shop's items
// (and of their sections) the brief or the owner lists («показывает услуги: дизайн квартиры, …», «Мы мастерская из
// Твери: кружки, тарелки, …») go to the seed of the draft as hints (gates.generateSeed {hints}): the visitor of the
// preview sees the owner's own offer, never «Товар «Летний»». Nothing invented (D49): only names, in his words.
import type { AppSpec, BriefScenario, SystemBrief } from "@wizard/appspec";
import { SEED_HINT_MAX_VALUES, type SeedHint, validateSeedHint } from "@wizard/gates";
import { CATALOG_NAMES, SHOP_NAMES } from "@wizard/modules";
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
  brief: Pick<SystemBrief, "scenarios">,
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
    (request ? offerOf(request, businessOf(request)) : null);
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
  return out;
}
