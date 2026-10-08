// pickArchetype (builder-v3.md#C2): a deterministic sampler of the direction by seed. Fit = niche stems (×3, up to two),
// goals of the brief (×1.5) and the system class (×1); the sampler draws among the archetypes that fit best, weighted
// by fit. Niche memory: archetypes of the last NICHE_MEMORY builds of the niche are skipped while a fitting
// alternative exists (research 2026-10-08 §4: a model cannot see its past builds, the system must vary them).
import {
  ARCHETYPES,
  type Archetype,
  type ArchetypeId,
  type GoalTag,
  type SystemClass,
} from "./archetypes.js";
import { rng } from "./random.js";

/** How many recent builds of a niche the sampler avoids repeating. */
export const NICHE_MEMORY = 4;

/** Goal stems (lower case, ё → е) over the goals and the niche. */
export const GOAL_STEMS: Readonly<Record<GoalTag, readonly string[]>> = {
  leads: ["заявк", "лид", "звонк", "обращен", "консультац", "клиент", "смет", "расчет"],
  booking: ["запис", "брон", "слот", "расписан", "прием", "визит", "сеанс"],
  sales: ["прода", "магазин", "корзин", "заказ", "каталог", "оплат", "доставк", "товар"],
  content: ["блог", "стат", "контент", "новост", "подписк", "публикац", "читател"],
  trust: ["довери", "репутац", "эксперт", "лиценз", "гарант", "надежн", "отзыв"],
  operations: [
    "учет",
    "crm",
    "срм",
    "админ",
    "сделк",
    "склад",
    "отчет",
    "задач",
    "сотрудник",
    "воронк",
    "остатк",
  ],
  events: ["билет", "мероприят", "афиш", "регистрац", "событи", "концерт"],
};

/** System class stems (D77 (12)); none matched — a business site. */
const CLASS_STEMS: Readonly<Record<Exclude<SystemClass, "site">, readonly string[]>> = {
  shop: ["интернет-магазин", "магазин", "корзин", "каталог товар", "оплат", "доставк"],
  booking: ["запис", "брон", "слот", "расписан", "кабинет клиент", "прием"],
  admin: ["crm", "срм", "учет", "админ", "сделк", "внутренн", "сотрудник", "склад", "диспетчер"],
};

export interface PickInput {
  niche: string;
  /** Goals of the brief: texts or {text} (C1 goals[]). */
  goals: readonly (string | { text: string })[];
  seed: string | number;
  /** Archetypes of the latest builds of this niche, most recent first. */
  recent?: readonly string[];
  /** Archetypes not to pick (the candidates already chosen). */
  exclude?: readonly string[];
  /** Builds of the niche to remember (default NICHE_MEMORY). */
  memory?: number;
}

export interface ArchetypePick {
  id: ArchetypeId;
  fit: number;
  /** Fitting archetypes skipped because recent builds of the niche used them. */
  avoided: ArchetypeId[];
}

/** Lower case, ё → е, single spaces. */
export const normalizeText = (s: string): string =>
  s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/** The stem starts a word of the text (so «бар» never matches «барбер» inside another word). */
export function hasStem(text: string, stem: string): boolean {
  const s = normalizeText(stem);
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1))
    if (i === 0 || !/[a-zа-я0-9]/.test(text[i - 1] as string)) return true;
  return false;
}

const goalText = (goals: PickInput["goals"]) =>
  normalizeText(goals.map((g) => (typeof g === "string" ? g : g.text)).join("; "));

/** Goal tags of a brief. */
export function goalTags(niche: string, goals: PickInput["goals"]): GoalTag[] {
  const text = `${normalizeText(niche)} ${goalText(goals)}`;
  return (Object.keys(GOAL_STEMS) as GoalTag[]).filter((g) => GOAL_STEMS[g].some((s) => hasStem(text, s)));
}

/** System classes of a brief (a business site when nothing else matches). */
export function systemClasses(niche: string, goals: PickInput["goals"]): SystemClass[] {
  const text = `${normalizeText(niche)} ${goalText(goals)}`;
  const out = (Object.keys(CLASS_STEMS) as Exclude<SystemClass, "site">[]).filter((c) =>
    CLASS_STEMS[c].some((s) => hasStem(text, s)),
  );
  return out.length ? out : ["site"];
}

/** How well an archetype fits the niche and goals (0 — nothing in common). */
export function archetypeFit(a: Archetype, niche: string, goals: PickInput["goals"]): number {
  const text = normalizeText(niche);
  const nicheHits = a.niches.filter((s) => hasStem(text, s)).length;
  const goalHits = goalTags(niche, goals).filter((g) => a.goals.includes(g)).length;
  const classHit = systemClasses(niche, goals).some((c) => a.classes.includes(c)) ? 1 : 0;
  return 3 * Math.min(nicheHits, 2) + 1.5 * goalHits + classHit;
}

/** The archetype of a brief: deterministic by seed, fits the niche and goals, avoids the niche's recent builds. */
export function pickArchetype(input: PickInput): ArchetypePick {
  const exclude = new Set(input.exclude ?? []);
  const recent = (input.recent ?? []).slice(0, input.memory ?? NICHE_MEMORY);
  const scored = ARCHETYPES.filter((a) => !exclude.has(a.id)).map((a) => ({
    a,
    fit: archetypeFit(a, input.niche, input.goals),
  }));
  if (!scored.length) throw new Error("pickArchetype: every archetype is excluded");
  const best = Math.max(...scored.map((s) => s.fit));
  // The fitting band: close to the best; with no fit at all — every archetype.
  const band = best > 0 ? scored.filter((s) => s.fit >= Math.max(1, best * 0.5)) : scored;
  const fresh = (list: typeof scored) => list.filter((s) => !recent.includes(s.a.id));
  let pool = fresh(band);
  if (!pool.length) pool = fresh(scored.filter((s) => s.fit > 0));
  if (!pool.length) {
    // Only recent ones fit: at least do not repeat the very last build.
    const notLast = band.filter((s) => s.a.id !== recent[0]);
    pool = notLast.length ? notLast : band;
  }
  const avoided = band.filter((s) => recent.includes(s.a.id) && !pool.includes(s)).map((s) => s.a.id);
  const r = rng(input.seed, `pick|${normalizeText(input.niche)}|${[...exclude].sort().join(",")}`);
  const weights = pool.map((s) => (s.fit + 0.5) ** 2);
  let x = r() * weights.reduce((sum, w) => sum + w, 0);
  for (const [i, s] of pool.entries()) {
    x -= weights[i] as number;
    if (x < 0) return { id: s.a.id, fit: s.fit, avoided };
  }
  const last = pool[pool.length - 1] as (typeof pool)[number];
  return { id: last.a.id, fit: last.fit, avoided };
}

/** `count` different archetypes: the first is pickArchetype(input), each next one excludes those already picked. */
export function pickArchetypes(input: PickInput, count = 3): ArchetypePick[] {
  const picks: ArchetypePick[] = [];
  for (let i = 0; i < Math.min(count, ARCHETYPES.length); i++)
    picks.push(pickArchetype({ ...input, exclude: [...(input.exclude ?? []), ...picks.map((p) => p.id)] }));
  return picks;
}
