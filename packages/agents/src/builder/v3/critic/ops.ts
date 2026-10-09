// Edits of the visual critic (V3-13): a closed set of operations on the composer's site model (ui/site.json, V3-12)
// and the client's design system (C2) that code applies safely — never free code. Each operation checks what it may
// touch: a variant of the same section type and module binding whose slot schema accepts the content and keeps the
// photos; a new section order with the first screen first; a text inside the slot schema that passes the copy rules
// (no new numbers — D49); a token step within the archetype and designLint; dropping a section nothing depends on.
import {
  archetype,
  type DesignSystemV3,
  designLintErrors,
  fluid,
  parseOklch,
  RADIUS_SETS,
  SECTION_SPACE,
} from "@wizard/ui-kit/v3/design";
import type { PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { z } from "zod";
import { slotShape } from "../compose/content.js";
import { copyIssues } from "../compose/lint.js";
import type { SectionPhotos, SiteModel, SitePage, SiteSection } from "../compose/site.js";

const route = z.string().trim().min(1).max(200);
const section = z.string().trim().min(1).max(60);

/** The operations (discriminated by `op`). */
export const editOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("swap_variant"), route, section, pattern: z.string().trim().min(1).max(80) }),
  z.object({ op: z.literal("reorder"), route, order: z.array(section).min(2).max(24) }),
  z.object({
    op: z.literal("set_text"),
    route,
    section,
    /** Dot path into the section props: «title», «items.1.text», «action.label». */
    path: z
      .string()
      .trim()
      .regex(/^[A-Za-z_]\w*(?:\.(?:\d+|[A-Za-z_]\w*)){0,4}$/),
    text: z.string().trim().min(1).max(400),
  }),
  z.object({
    op: z.literal("token"),
    token: z.enum(["density", "radius", "display_size", "muted_contrast"]),
    /** density: compact|regular|airy; radius: sharp|crisp|soft|round; display_size: smaller|larger; muted_contrast: light|dark. */
    value: z.string().trim().min(1).max(20),
  }),
  z.object({ op: z.literal("drop_section"), route, section }),
]);
export type EditOp = z.output<typeof editOpSchema>;

/** What the critic edits: the site model and the design system. */
export interface CriticState {
  site: SiteModel;
  design: DesignSystemV3;
}

export interface EditEnv {
  library: readonly PatternMeta[];
  /** Numbers of the facts (siteFacts): a text may not bring a number the brief does not have (D49). */
  numbers: ReadonlySet<string>;
}

export type EditResult =
  | { ok: true; state: CriticState; summary_ru: string; touched: "page" | "site"; route?: string }
  | { ok: false; reason_ru: string };

/** Binding slots of the module-bound patterns (V3-08): never texts (the composer's FIXED_KEYS). */
const FIXED_KEYS = new Set(["entity", "booking", "categoryEntity", "fields", "itemAction"]);
/** Keys whose strings are links, sources or identifiers, not copy. */
const NOT_COPY = new Set([
  "href",
  "src",
  "id",
  "icon",
  "value",
  "type",
  "name",
  "tel",
  "phone",
  "email",
  "url",
]);
/** Photos a variant must keep when the section has them (the composer's KEEP). */
const PHOTO_KEYS = [["image", "images"], ["columns"]] as const;

const CHROME = new Set(["header", "footer"]);
const fail = (reason_ru: string): EditResult => ({ ok: false, reason_ru });

const findPage = (site: SiteModel, r: string) => site.pages.find((p) => p.route === r);
const withPage = (site: SiteModel, page: SitePage): SiteModel => ({
  ...site,
  pages: site.pages.map((p) => (p.route === page.route ? page : p)),
});
const metaOf = (lib: readonly PatternMeta[], id: string) => lib.find((p) => p.id === id);
const isBound = (lib: readonly PatternMeta[], s: SiteSection) =>
  (metaOf(lib, s.pattern)?.needs ?? null) !== null || Object.keys(s.props).some((k) => FIXED_KEYS.has(k));

/**
 * Props the variant keeps of the content, or null when its slots refuse it or it would drop the photos — the stock
 * ones of the props or the place of the owner's photo («Фото сайта», V3-18).
 */
function fitProps(
  meta: PatternMeta,
  props: Record<string, unknown>,
  photos?: SectionPhotos,
): Record<string, unknown> | null {
  const r = meta.slots.safeParse(props);
  if (!r.success) return null;
  const out = r.data as Record<string, unknown>;
  for (const group of PHOTO_KEYS)
    if (group.some((k) => props[k] !== undefined) && !group.some((k) => out[k] !== undefined)) return null;
  if (photos?.image && !slotShape(meta).keys.has("image")) return null;
  // The binding stays too: a variant without item actions would drop where a catalog item leads (GS-catalog-4).
  for (const k of FIXED_KEYS) if (props[k] !== undefined && out[k] === undefined) return null;
  return out;
}

/** Variants a section may take: same type and binding, the slots accept its content, the photos stay. */
export function variantsFor(lib: readonly PatternMeta[], s: SiteSection): PatternMeta[] {
  if (s.type === "signature") return [];
  const needs = metaOf(lib, s.pattern)?.needs ?? null;
  return lib.filter(
    (p) =>
      p.id !== s.pattern &&
      p.sectionType === s.type &&
      p.needs === needs &&
      fitProps(p, s.props, s.photos) !== null,
  );
}

function swapVariant(st: CriticState, op: Extract<EditOp, { op: "swap_variant" }>, env: EditEnv): EditResult {
  const page = findPage(st.site, op.route);
  const s = page?.sections.find((x) => x.id === op.section);
  if (!page || !s) return fail(`нет секции ${op.section} на странице ${op.route}`);
  if (s.type === "signature") return fail("фирменная секция написана кодом — у неё нет вариантов");
  const meta = metaOf(env.library, op.pattern);
  if (!meta) return fail(`варианта ${op.pattern} нет в библиотеке`);
  if (meta.id === s.pattern) return fail("секция уже в этом варианте");
  const needs = metaOf(env.library, s.pattern)?.needs ?? null;
  if (meta.sectionType !== s.type || meta.needs !== needs)
    return fail(`вариант ${op.pattern} — для другой секции или другой привязки к данным`);
  // Header and footer are one for the whole site: the variant changes on every page.
  const pages = CHROME.has(s.type) ? st.site.pages : [page];
  const next: SitePage[] = [];
  for (const p of pages) {
    const sections: SiteSection[] = [];
    for (const x of p.sections) {
      if (CHROME.has(s.type) ? x.type !== s.type : x.id !== s.id) {
        sections.push(x);
        continue;
      }
      const props = fitProps(meta, x.props, x.photos);
      if (!props)
        return fail(
          `вариант ${op.pattern} не принимает содержимое секции, теряет фото или привязку к данным`,
        );
      sections.push({ ...x, pattern: meta.id, props });
    }
    next.push({ ...p, sections });
  }
  let site = st.site;
  for (const p of next) site = withPage(site, p);
  return {
    ok: true,
    state: { ...st, site },
    summary_ru: `${op.route}#${s.id}: вариант ${s.pattern} → ${meta.id}`,
    ...(CHROME.has(s.type) ? { touched: "site" as const } : { touched: "page" as const, route: op.route }),
  };
}

function reorder(st: CriticState, op: Extract<EditOp, { op: "reorder" }>): EditResult {
  const page = findPage(st.site, op.route);
  if (!page) return fail(`нет страницы ${op.route}`);
  const body = page.sections.filter((s) => !CHROME.has(s.type));
  const ids = body.map((s) => s.id);
  if (
    op.order.length !== ids.length ||
    new Set(op.order).size !== ids.length ||
    !op.order.every((i) => ids.includes(i))
  )
    return fail(`порядок должен перечислить все секции страницы ровно по разу: ${ids.join(", ")}`);
  const hero = body.find((s) => s.type === "hero");
  if (hero && op.order[0] !== hero.id) return fail("первый экран (hero) остаётся первым");
  if (op.order.every((id, i) => ids[i] === id)) return fail("порядок не изменился");
  const byId = new Map(body.map((s) => [s.id, s]));
  const sections = [
    ...page.sections.filter((s) => s.type === "header"),
    ...op.order.map((id) => byId.get(id) as SiteSection),
    ...page.sections.filter((s) => s.type === "footer"),
  ];
  return {
    ok: true,
    state: { ...st, site: withPage(st.site, { ...page, sections }) },
    summary_ru: `${op.route}: порядок секций ${op.order.join(" → ")}`,
    touched: "page",
    route: op.route,
  };
}

/** The props with the string at `path` replaced, or the reason it cannot be. */
function setAt(props: Record<string, unknown>, path: string, text: string): Record<string, unknown> | string {
  const keys = path.split(".");
  const root = structuredClone(props) as Record<string, unknown>;
  let cur: unknown = root;
  for (const [i, k] of keys.entries()) {
    if (FIXED_KEYS.has(k)) return "привязка к данным — не текст";
    const last = i === keys.length - 1;
    const box = cur as Record<string, unknown> | unknown[];
    const at = Array.isArray(box) ? box[Number(k)] : (box as Record<string, unknown>)[k];
    if (at === undefined || at === null) return `в секции нет поля ${path}`;
    if (last) {
      if (typeof at !== "string") return `поле ${path} — не текст`;
      if (NOT_COPY.has(k)) return `поле ${path} — ссылка или служебное значение, не текст`;
      if (at.trim() === text.trim()) return "текст не изменился";
      if (Array.isArray(box)) box[Number(k)] = text;
      else (box as Record<string, unknown>)[k] = text;
      return root;
    }
    if (typeof at !== "object") return `в секции нет поля ${path}`;
    cur = at;
  }
  return `в секции нет поля ${path}`;
}

function setText(st: CriticState, op: Extract<EditOp, { op: "set_text" }>, env: EditEnv): EditResult {
  const page = findPage(st.site, op.route);
  const s = page?.sections.find((x) => x.id === op.section);
  if (!page || !s) return fail(`нет секции ${op.section} на странице ${op.route}`);
  if (s.type === "signature") return fail("тексты фирменной секции меняются только с её кодом");
  if (CHROME.has(s.type)) return fail("меню и подвал собираются из страниц сайта — их тексты не правятся");
  const key = op.path.split(".").at(-1) ?? "";
  const issues = copyIssues(op.text, key === "alt" ? undefined : env.numbers);
  if (issues.length)
    return fail(
      `текст не прошёл правила письма: ${issues.map((i) => `${i.code} «${i.evidence}»`).join("; ")}`,
    );
  if (key === "alt" && op.text.trim().length < 5) return fail("подпись фото должна описывать снимок");
  const props = setAt(s.props, op.path, op.text.trim());
  if (typeof props === "string") return fail(props);
  const meta = metaOf(env.library, s.pattern);
  const parsed = meta ? meta.slots.safeParse(props) : null;
  if (parsed && !parsed.success)
    return fail(`текст не помещается в схему секции: ${parsed.error.issues[0]?.message ?? ""}`);
  const sections = page.sections.map((x) =>
    x.id === s.id ? { ...x, props: (parsed?.data as Record<string, unknown>) ?? props } : x,
  );
  return {
    ok: true,
    state: { ...st, site: withPage(st.site, { ...page, sections }) },
    summary_ru: `${op.route}#${s.id}: текст ${op.path} → «${op.text.trim().slice(0, 60)}»`,
    touched: "page",
    route: op.route,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function token(st: CriticState, op: Extract<EditOp, { op: "token" }>): EditResult {
  const ds = st.design;
  const a = archetype(ds.archetype);
  if (!a) return fail("архетип дизайн-системы неизвестен");
  let next: DesignSystemV3;
  let what: string;
  if (op.token === "density") {
    const d = op.value as DesignSystemV3["grid"]["rhythm"]["density"];
    if (!a.density.includes(d)) return fail(`плотность архетипа: ${a.density.join(", ")}`);
    if (d === ds.grid.rhythm.density) return fail("плотность уже такая");
    next = { ...ds, grid: { ...ds.grid, rhythm: { density: d, section: { ...SECTION_SPACE[d] } } } };
    what = `плотность ${ds.grid.rhythm.density} → ${d}`;
  } else if (op.token === "radius") {
    const r = op.value as DesignSystemV3["radius"]["set"];
    if (!a.radius.includes(r)) return fail(`скругления архетипа: ${a.radius.join(", ")}`);
    if (r === ds.radius.set) return fail("скругления уже такие");
    const [sm, md, lg] = RADIUS_SETS[r];
    const pill = ds.radius.control > ds.radius.lg;
    next = { ...ds, radius: { set: r, sm, md, lg, control: pill ? ds.radius.control : md } };
    what = `скругления ${ds.radius.set} → ${r}`;
  } else if (op.token === "display_size") {
    if (op.value !== "smaller" && op.value !== "larger") return fail("display_size: smaller или larger");
    const f = op.value === "smaller" ? 0.9 : 1.1;
    const d = ds.type.steps.display;
    const min = round2(d.min * f);
    const max = round2(d.max * f);
    next = {
      ...ds,
      type: { ...ds.type, steps: { ...ds.type.steps, display: { ...d, min, max, size: fluid(min, max) } } },
    };
    what = `заголовок первого экрана ${op.value === "smaller" ? "на ступень меньше" : "крупнее"}`;
  } else {
    if (op.value !== "light" && op.value !== "dark") return fail("muted_contrast: light или dark");
    const scheme = op.value;
    const muted = parseOklch(ds.palette[scheme].muted);
    const ink = parseOklch(ds.palette[scheme].ink);
    if (!muted || !ink) return fail("цвет второстепенного текста не в OKLCH");
    const l = round2(Math.min(1, Math.max(0, muted.l + (scheme === "light" ? -0.05 : 0.05))));
    // The secondary text must stay secondary (catalog: hierarchy by colour).
    if (Math.abs(l - ink.l) < 0.08) return fail("второстепенный текст сольётся с основным");
    const css = `oklch(${l} ${muted.c} ${muted.h})`;
    next = {
      ...ds,
      palette: { ...ds.palette, [scheme]: { ...ds.palette[scheme], muted: css } },
    };
    what = `второстепенный текст контрастнее (${scheme === "light" ? "светлая" : "тёмная"} тема)`;
  }
  const errors = designLintErrors(next);
  if (errors.length) return fail(`правка нарушает проверки дизайн-системы: ${errors[0]?.message ?? ""}`);
  return { ok: true, state: { ...st, design: next }, summary_ru: `токены: ${what}`, touched: "site" };
}

function drop(st: CriticState, op: Extract<EditOp, { op: "drop_section" }>, env: EditEnv): EditResult {
  const page = findPage(st.site, op.route);
  const s = page?.sections.find((x) => x.id === op.section);
  if (!page || !s) return fail(`нет секции ${op.section} на странице ${op.route}`);
  if (CHROME.has(s.type) || s.type === "hero") return fail("меню, подвал и первый экран не убираются");
  if (s.type === "signature") return fail("фирменная секция не убирается");
  if (isBound(env.library, s)) return fail("секция с формой или данными нужна сценариям брифа");
  // V3-18: the owner's photo of «Фото сайта» must reach the page (GS-landing-2).
  if (s.photos && Object.keys(s.photos).length) return fail("в секции место для фото владельца");
  if (page.sections.filter((x) => !CHROME.has(x.type)).length <= 2)
    return fail("на странице останется только первый экран");
  return {
    ok: true,
    state: {
      ...st,
      site: withPage(st.site, { ...page, sections: page.sections.filter((x) => x.id !== s.id) }),
    },
    summary_ru: `${op.route}: убрал секцию ${s.id}`,
    touched: "page",
    route: op.route,
  };
}

/** Applies one operation to the state (pure; the hook then lints, builds and checks it in the browser). */
export function applyEdit(st: CriticState, op: EditOp, env: EditEnv): EditResult {
  switch (op.op) {
    case "swap_variant":
      return swapVariant(st, op, env);
    case "reorder":
      return reorder(st, op);
    case "set_text":
      return setText(st, op, env);
    case "token":
      return token(st, op);
    case "drop_section":
      return drop(st, op, env);
  }
}
