// Facts of the public site (D49, catalog H.4): what the pages may say comes from the brief, the approved plan and the
// spec — the business name, niche, the owner's landing texts, photos, the personal data operator and contacts. Texts
// marked as an example («Пример: …») are dropped. Every number a page shows must be found here (fabricated check).
import type { SystemBrief, SystemPlan } from "@wizard/appspec";
import { type PhotoSectionType, photoSlots, SITE_PHOTO } from "@wizard/modules";
import { isKeywordNiche } from "../../../planner/fallback.js";
import type { V3BuildContext } from "../contract.js";
import { type BriefCopy, briefCopy } from "./copy.js";

/** A photo the site may show: a copy in the platform photo library (same origin) with its alt. */
export interface SitePhoto {
  slot: string;
  src: string;
  alt: string;
}

export interface SiteFacts {
  name: string;
  niche: string;
  description?: string;
  audience?: string;
  /** Goals of the brief (internal statements: they steer the copy, they are not shown as is). */
  goals: string[];
  /**
   * The owner's landing texts of the plan by section type (first section of the type): examples and the planner's
   * placeholders (a heading equal to the niche, «Связаться») dropped.
   */
  texts: Map<string, Record<string, unknown>>;
  /** Texts of the skeleton the brief gives where the owner wrote none (V3-18: heading, lead, form headings). */
  copy: BriefCopy;
  photos: SitePhoto[];
  /**
   * Places of the site the owner may put his own photo into («Фото сайта» of the cabinet, B2-38): the landing's photo
   * slots of the plan, in page order — the sections of the same type show them (V3-18); none without site_photo.
   */
  places: { slot: string; type: PhotoSectionType }[];
  /** The personal data operator (spec compliance), its ИНН and contacts. */
  operator?: string;
  operatorInn?: string;
  /** ОГРН or ОГРНИП of the seller (V3-18: a shop's requisites in the footer). */
  operatorOgrn?: string;
  phone?: string;
  email?: string;
  address?: string;
  policyPage: string;
  /**
   * Bookings wait for the staff's confirmation (the booking module's confirm = manual: a new booking's status is
   * «new»): the booking form says «Заявка на запись отправлена», as the module's v2 page (V3-18).
   */
  bookingByRequest: boolean;
  /** Every number of the facts, normalised (digits, one decimal separator). */
  numbers: Set<string>;
}

const EXAMPLE_RE = /^\s*пример\b/i;
/** The planner's placeholder of a button (planner/edits.ts sectionContent): the owner did not write it. */
const PLACEHOLDER_CTA = "Связаться";
const PHOTO_WIDTH = 1600;
const NUMBER_RE = /\d(?:[\d   ]*\d)?(?:[.,]\d+)?/g;

/** Numbers of a text, normalised: «2 500» → «2500», «4,5» → «4.5». */
export function numbersOf(text: string): string[] {
  return [...text.matchAll(NUMBER_RE)].map((m) => m[0].replace(/[\s  ]/g, "").replace(",", "."));
}

function strings(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
}

/** Every string leaf of a value (props, plan content). */
export function textLeaves(v: unknown): string[] {
  const out: string[] = [];
  strings(v, out);
  return out;
}

/** Content of a plan section without example texts (a value whose text starts with «Пример» is dropped). */
function clean(content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(content)) {
    if (typeof v === "string") {
      if (v.trim() && !EXAMPLE_RE.test(v)) out[k] = v.trim();
    } else if (Array.isArray(v)) {
      const items = v.filter((x) => !textLeaves(x).some((t) => EXAMPLE_RE.test(t)));
      if (items.length) out[k] = items;
    }
  }
  return out;
}

function landingTexts(plan: SystemPlan): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  // Placeholders of the planner (planner/edits.ts sectionContent): the heading is the niche, the button «Связаться».
  const niche = plan.niche.charAt(0).toUpperCase() + plan.niche.slice(1);
  for (const s of plan.landing?.sections ?? []) {
    if (out.has(s.type)) continue;
    const c = clean(s.content);
    if (c.title === niche) delete c.title;
    if (c.cta === PLACEHOLDER_CTA) delete c.cta;
    if (Object.keys(c).length) out.set(s.type, c);
  }
  return out;
}

function photosOf(plan: SystemPlan): SitePhoto[] {
  return (plan.design?.photos ?? []).map((p) => ({
    slot: p.slot,
    src: `/_wizard/photos/${p.file}/${PHOTO_WIDTH}`,
    alt: p.alt,
  }));
}

function contactOf(c: string | undefined): { phone?: string; email?: string } {
  if (!c) return {};
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.trim())) return { email: c.trim() };
  const digits = c.replace(/[^\d+]/g, "");
  return /^\+?\d{10,15}$/.test(digits) ? { phone: c.trim() } : {};
}

function briefTexts(brief: SystemBrief): string[] {
  const out: string[] = [brief.audience];
  for (const g of brief.goals) out.push(g.text, g.success);
  for (const s of brief.scenarios) out.push(s.when, ...s.then);
  for (const q of brief.qa) out.push(q.a);
  for (const o of brief.outOfScope) out.push(o.text, o.substitute ?? "");
  return out.filter(Boolean);
}

/** The facts of a build context. */
export function siteFacts(ctx: Pick<V3BuildContext, "brief" | "plan" | "spec" | "request">): SiteFacts {
  const { brief, plan, spec } = ctx;
  const texts = landingTexts(plan);
  const c = spec.compliance ?? {};
  const corpus = [
    spec.app.name,
    spec.app.description ?? "",
    plan.niche,
    ...plan.goals.map((g) => g.statement),
    ...textLeaves([...texts.values()]),
    ...briefTexts(brief),
    c.operatorName ?? "",
    c.operatorAddress ?? "",
    c.operatorContact ?? "",
    c.operatorInn ?? "",
    c.operatorOgrn ?? "",
  ];
  const numbers = new Set(corpus.flatMap(numbersOf));
  const contact = contactOf(c.operatorContact);
  const description = spec.app.description?.trim();
  const audience = brief.audience.trim();
  return {
    name: spec.app.name,
    niche: plan.niche,
    ...(description ? { description } : {}),
    ...(audience ? { audience } : {}),
    goals: brief.goals.length ? brief.goals.map((g) => g.text) : plan.goals.map((g) => g.statement),
    texts,
    copy: briefCopy({
      name: spec.app.name,
      niche: plan.niche,
      keywordNiche: isKeywordNiche(plan.niche),
      brief,
      ...(ctx.request ? { request: ctx.request } : {}),
    }),
    photos: photosOf(plan),
    places: spec.entities.some((e) => e.name === SITE_PHOTO.entity)
      ? photoSlots(plan).map((p) => ({ slot: p.slot, type: p.type }))
      : [],
    ...(c.operatorName ? { operator: c.operatorName } : {}),
    ...(c.operatorInn ? { operatorInn: c.operatorInn } : {}),
    ...(c.operatorOgrn ? { operatorOgrn: c.operatorOgrn } : {}),
    ...contact,
    ...(c.operatorAddress ? { address: c.operatorAddress } : {}),
    policyPage: c.policyPage ?? "/privacy",
    bookingByRequest:
      spec.entities.find((e) => e.name === "booking")?.fields.find((f) => f.name === "status")?.default ===
      "new",
    numbers,
  };
}

/** A string field of the owner's landing texts. */
export function textOf(facts: SiteFacts, type: string, key: string): string | undefined {
  const v = facts.texts.get(type)?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A photo of a slot («top», «top-2», «about»…). */
export function photoOf(facts: SiteFacts, slot: string): SitePhoto | undefined {
  return facts.photos.find((p) => p.slot === slot);
}
