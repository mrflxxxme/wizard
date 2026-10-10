// Pattern library v3 (specs/agents/builder-v3.md C3): section variants whose TSX is copied into systems as
// ui/patterns/<id>.tsx (the shadcn model). Data only here; the registry is assembled in index.ts.
import type { z } from "zod";

/** Section types of public pages v3 (backlog V3-08): one folder of patterns per type. */
export const SECTION_TYPES = [
  "header",
  "hero",
  "services",
  "about",
  "testimonials",
  "pricing",
  "gallery",
  "team",
  "faq",
  "contacts",
  "cta",
  "form",
  "catalog",
  "blog",
  "footer",
  // V3-24 «Контент и блог»: one entry by the slug of the address (article, page) and the posts of a rubric.
  "article",
  "rubric",
  // V3-18: the client cabinet /me of «Кабинет посетителя» (the visitor's own records).
  "account",
  // V3-23 «Интернет-магазин»: the goods with «В корзину», the cart with the checkout, the order of its buyer.
  "shop",
  "cart",
  "order",
  // V3-18: the page of one product (/shop/:id).
  "product",
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/**
 * Structural family of a variant (composition, not colour): patternFor spreads families over a page so that a page
 * does not repeat one layout (catalog L06).
 */
export const LAYOUT_FAMILIES = [
  "bar",
  "stacked",
  "split",
  "centered",
  "asymmetric",
  "full-bleed",
  "typographic",
  "card",
  "collage",
  "editorial",
  "band",
  "columns",
  "panel",
  "list",
  "grid",
] as const;
export type LayoutFamily = (typeof LAYOUT_FAMILIES)[number];

/** Module logic a pattern binds through @wizard/ui-kit/v3/headless (C4); null — content only. */
export type PatternNeeds = "lead" | "booking" | "catalog" | "cart" | "content" | null;

/** License of the pattern code: own code or a rewrite of an MIT / Apache-2.0 source (D47, GZ-02). */
export type PatternLicense = "MIT" | "Apache-2.0" | "own";

/** Where the composition comes from: "own" or an allowed source of origins.ts (attributed in THIRD_PARTY_NOTICES). */
export type PatternOrigin = "own" | "hyperui" | "shadcn-ui" | "radix" | "motion" | "magic-ui";

/** Archetype ids of the design system (C2) a pattern suits; "*" — any archetype. */
export type PatternArchetypes = readonly string[];

export interface PatternMeta<S extends z.ZodType = z.ZodType> {
  /** `<sectionType>-<variant>`, also the file name in the system. */
  id: string;
  sectionType: SectionType;
  variant: string;
  layout: LayoutFamily;
  /** What the variant looks like, in Russian (for the agent and the owner). */
  title: string;
  archetypes: PatternArchetypes;
  /** Content of the pattern: the props of its component; texts come from the brief. */
  slots: S;
  needs: PatternNeeds;
  /** TSX copied into the system; imports only react, motion/react, @wizard/ui-kit/v3/headless. */
  source: string;
  /** Path in the system: ui/patterns/<id>.tsx. */
  file: string;
  license: PatternLicense;
  origin: PatternOrigin;
  /** Preview content for tests and previews only (marked as an example, D49): never published as the client's text. */
  example: z.input<S>;
}
