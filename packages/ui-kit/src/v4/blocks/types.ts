// Block library v4 (V5-01, D80 (2)–(4)): curated sections of public pages. The director picks 6–9 blocks, fills
// their slots and variants and tunes the tokens; it never edits the TSX. Data only here; the catalog is index.ts.
import type { z } from "zod";

/** Section kinds of the library; every kind of the v3 patterns (SECTION_TYPES) has at least one block. */
export const BLOCK_KINDS = [
  "hero",
  "nav",
  "logos",
  "features",
  "services",
  "catalog",
  "about",
  "stats",
  "steps",
  "testimonials",
  "pricing",
  "gallery",
  "team",
  "faq",
  "cta",
  "contacts",
  "footer",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Weight of the block's effect (D80 (4)): one heavy effect per page, the rest light motion. */
export type BlockEffect = "none" | "light" | "heavy";

/** Where an effect idea comes from: own code or a rewrite after an MIT kit (attributed in THIRD_PARTY_NOTICES). */
export type BlockOrigin = "own" | "magic-ui" | "shadcn-ui";

export interface BlockVariant {
  id: string;
  /** What the variant changes, in Russian (for the director and the owner). */
  title: string;
}

export interface BlockMeta<S extends z.ZodType = z.ZodType> {
  /** `<kind>-<name>`, also the file name `<kind>/<name>.tsx`. */
  id: string;
  kind: BlockKind;
  /** Name of the block, in Russian. */
  title: string;
  /** When to pick it and what it shows, in Russian (read by the director). */
  description: string;
  /** Props of the component: texts, photos (same-origin), Lucide icon names; machine-readable via zod. */
  slots: S;
  /** Values of the `variant` slot; the first one is the default. */
  variants: readonly BlockVariant[];
  effect: BlockEffect;
  origin: BlockOrigin;
  /** Preview content only (D49): an example business, never the client's text. */
  example: z.input<S>;
}
