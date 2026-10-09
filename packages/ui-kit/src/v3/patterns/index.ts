// @wizard/ui-kit/v3/patterns — pattern library v3 (specs/agents/builder-v3.md C3). Node side: agents and tests read
// it; systems get only the TSX of the chosen patterns (ui/patterns/<id>.tsx). This file only collects the section type
// folders: a new type adds its import and its spread below.

import { ABOUT_PATTERNS } from "./about/index.js";
import { ACCOUNT_PATTERNS } from "./account/index.js";
import { ARTICLE_PATTERNS } from "./article/index.js";
import { BLOG_PATTERNS } from "./blog/index.js";
import { CART_PATTERNS } from "./cart/index.js";
import { CATALOG_PATTERNS } from "./catalog/index.js";
import { CONTACTS_PATTERNS } from "./contacts/index.js";
import { CTA_PATTERNS } from "./cta/index.js";
import { FAQ_PATTERNS } from "./faq/index.js";
import { FOOTER_PATTERNS } from "./footer/index.js";
import { FORM_PATTERNS } from "./form/index.js";
import { GALLERY_PATTERNS } from "./gallery/index.js";
import { HEADER_PATTERNS } from "./header/index.js";
import { HERO_PATTERNS } from "./hero/index.js";
import { ORDER_PATTERNS } from "./order/index.js";
import { PRICING_PATTERNS } from "./pricing/index.js";
import { RUBRIC_PATTERNS } from "./rubric/index.js";
import { type PatternQuery, selectPattern } from "./select.js";
import { SERVICES_PATTERNS } from "./services/index.js";
import { SHOP_PATTERNS } from "./shop/index.js";
import { TEAM_PATTERNS } from "./team/index.js";
import { TESTIMONIALS_PATTERNS } from "./testimonials/index.js";
import type { PatternMeta } from "./types.js";

/** Every pattern of the library. */
export const PATTERNS: readonly PatternMeta[] = [
  ...HEADER_PATTERNS,
  ...HERO_PATTERNS,
  ...CTA_PATTERNS,
  ...FOOTER_PATTERNS,
  ...TESTIMONIALS_PATTERNS,
  ...PRICING_PATTERNS,
  ...GALLERY_PATTERNS,
  ...CONTACTS_PATTERNS,
  ...SERVICES_PATTERNS,
  ...ABOUT_PATTERNS,
  ...TEAM_PATTERNS,
  ...FAQ_PATTERNS,
  ...FORM_PATTERNS,
  ...CATALOG_PATTERNS,
  ...BLOG_PATTERNS,
  ...ARTICLE_PATTERNS,
  ...RUBRIC_PATTERNS,
  ...ACCOUNT_PATTERNS,
  ...SHOP_PATTERNS,
  ...CART_PATTERNS,
  ...ORDER_PATTERNS,
];

/** Deterministic choice of a variant for a section: by seed, archetype, without repeating used ones (C3). */
export function patternFor(q: PatternQuery): PatternMeta | null {
  return selectPattern(PATTERNS, q);
}

/** The pattern with this id. */
export function patternById(id: string): PatternMeta | undefined {
  return PATTERNS.find((p) => p.id === id);
}

/** Files to copy into a system for these patterns: ui/patterns/<id>.tsx → TSX. Unknown ids throw. */
export function patternFiles(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const p = patternById(id);
    if (!p) throw new Error(`unknown pattern ${id}`);
    out.set(p.file, p.source);
  }
  return out;
}

/** definePattern(): registers `<folder>/<variant>.tsx` of a section type folder. */
export { definePattern, type PatternSpec } from "./define.js";
/** lintPattern(source): theme-only colours and fonts, allowed imports, no invented facts, a11y of img/button/a, motion. */
export { lintPattern, PATTERN_IMPORTS, type PatternLintCode, type PatternLintIssue } from "./lint.js";
/** Allowed origins (MIT, Apache-2.0) and the sources that never reach patterns. */
export {
  ALLOWED_PATTERN_LICENSES,
  FORBIDDEN_PATTERN_SOURCES,
  type ForbiddenSource,
  forbiddenSourceIn,
  type OriginInfo,
  PATTERN_ORIGINS,
} from "./origins.js";
export { hash32, type PatternQuery, selectPattern } from "./select.js";
/** Slot primitives: links, images (same-origin only), texts with limits. */
export { brandSlot, HREF_RE, imageSlot, line, linkSlot, para, SAME_ORIGIN_PATH_RE } from "./slots.js";
/** Theme contract with the design system (C2): Tailwind theme keys and the motion profile variable. */
export { MOTION_PROFILE_VAR, PATTERN_THEME, patternThemeVars } from "./theme.js";
export {
  LAYOUT_FAMILIES,
  type LayoutFamily,
  type PatternArchetypes,
  type PatternLicense,
  type PatternMeta,
  type PatternNeeds,
  type PatternOrigin,
  SECTION_TYPES,
  type SectionType,
} from "./types.js";
