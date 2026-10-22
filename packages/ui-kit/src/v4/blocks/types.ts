// Machine-readable description of a library block (V5-01, grill-11 (1), grill-12 (2)): what the block director (V5-03)
// reads to pick a block and fill its slots. A block belongs to one direction and renders one section of a site.
import type { ComponentType } from "react";
import type { DesignSystemV3 } from "../../v3/design/index.js";

/** Directions of the library in wave V5 (grill-12 (2)); «Чистая медицина» and «Редакция» came with V5-09. */
export type DirectionId = "masterskaya" | "nochnoy-produkt" | "chistaya-medicina" | "redaktsiya";

/** What a section does on the page; the director builds a page as a sequence of these. */
export type SectionType =
  | "header"
  | "hero"
  | "menu"
  | "prices"
  | "moment"
  | "order"
  | "booking"
  | "status"
  | "steps"
  | "team"
  | "locations"
  | "reviews"
  | "contacts"
  | "footer";

/** One slot of a block: a piece of content the director (or the copywriter) must supply. */
export type SlotSpec =
  /** Plain Russian text; `max` is a hard length limit in characters, `min` a lower bound when set. */
  | { kind: "text"; max: number; min?: number; optional?: boolean; hint: string }
  /** A number (price in roubles, count). */
  | { kind: "number"; optional?: boolean; hint: string }
  /** `tel:` or `#anchor` link. */
  | { kind: "href"; optional?: boolean; hint: string }
  /** A stock photo copy with alt and credit (D61); `hint` is the subject to pick by meaning (V4-10). */
  | { kind: "photo"; optional?: boolean; hint: string }
  /** A Lucide icon by its kebab-case name (MIT); none of the bar blocks needs one, the kind is for later directions. */
  | { kind: "icon"; optional?: boolean; hint: string }
  /** The business mark: SVG in currentColor; without it the name is set in the display face. */
  | { kind: "mark"; optional?: boolean; hint: string }
  /** A repeated group with a count range. */
  | { kind: "list"; min: number; max: number; item: Record<string, SlotSpec>; hint: string }
  /** A nested group of slots (another block's content, or a fixed record). */
  | { kind: "group"; slots: Record<string, SlotSpec>; optional?: boolean; hint: string };

/** How a block moves: none, a micro movement, or the one signature moment of its direction (grill-11 (5)). */
export type BlockMotion = "none" | "micro" | "signature";

/** The description of a block the director reads; no JSX in it. */
export interface BlockSpec {
  /** `<direction>.<name>`, stable across releases. */
  id: string;
  direction: DirectionId;
  section: SectionType;
  /** Russian name for the founder and the canvas. */
  title: string;
  /** When to use the block, one Russian sentence. */
  use: string;
  slots: Record<string, SlotSpec>;
  /** Variant ids with Russian labels; the first is the default. */
  variants: readonly { id: string; label: string }[];
  /** Design tokens (Tailwind theme names of design/css.ts) the block paints with. */
  tokens: readonly string[];
  motion: BlockMotion;
  /** True for the block carrying its direction's signature moment (one per direction). */
  signature: boolean;
}

/** Props of every block component: its content (shape described by `slots`) and an optional variant id. */
export type BlockProps<C> = { content: C; variant?: string };

/** A block of the catalog: the description and the component. */
export interface Block<C = never> {
  spec: BlockSpec;
  Component: ComponentType<BlockProps<C>>;
}

/** A direction: composition grammar, tokens (an explicit brand choice), and its signature moment. */
export interface Direction {
  id: DirectionId;
  /** Russian name as in grill-11 (1). */
  title: string;
  /** Niches the direction is for (Russian). */
  niches: readonly string[];
  /** Grammar in one Russian paragraph: type, grid, photo handling, rhythm. */
  grammar: string;
  /** Tokens of the direction: palette from an explicit brand colour, font pair with a reason. */
  design: DesignSystemV3;
  /** Why this brand colour and fonts (grill-11 (8): no palette without an explicit brand choice). */
  brandChoice: string;
  /** The signature moment: block id and what moves. */
  signature: { block: string; moment: string };
}
