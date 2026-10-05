// Props of the landing blocks (ui-kit.yaml#components, M2-43). Content always comes from the builder (the owner's facts);
// blocks add only structural texts (menu, policy link, form states).
import type { ReactNode } from "react";
import type { WzBase } from "../../data/context.js";
import type { ImageSource } from "../media/Image.js";

export type BlockLink = { label: string; href: string };
/** Background of a section: page, alternate band, or the brand colour (text in --w-accent-ink). */
export type BlockTone = "default" | "alt" | "accent";

interface BlockBase extends WzBase {
  /** id of the section for in-page links (href="#lead"). */
  anchor?: string;
}

export interface HeaderProps extends WzBase {
  /** Name of the business (text logo; the logo picture, when given, gets it as alt). */
  brand: string;
  logo?: ImageSource;
  links?: BlockLink[];
  cta?: BlockLink;
  /** bar — logo left, menu right; centered — logo above the menu. */
  variant?: "bar" | "centered";
  /** Stays at the top while scrolling. */
  sticky?: boolean;
}

export interface HeroProps extends BlockBase {
  title: string;
  subtitle?: string;
  /** Small line above the title (city, kind of business). */
  eyebrow?: string;
  primary?: BlockLink;
  secondary?: BlockLink;
  image?: ImageSource;
  /** split — text and picture side by side; centered — text in the middle, picture below; cover — picture behind text. */
  variant?: "split" | "centered" | "cover";
  tone?: Exclude<BlockTone, "alt">;
}

export type FeatureItem = { title: string; text?: string; image?: ImageSource };
export interface FeaturesProps extends BlockBase {
  title: string;
  intro?: string;
  items: FeatureItem[];
  /** grid — short points; cards — cards with pictures; alternating — picture and text rows in turn. */
  variant?: "grid" | "cards" | "alternating";
  columns?: 2 | 3 | 4;
  tone?: BlockTone;
}

export type StepItem = { title: string; text?: string };
export interface StepsProps extends BlockBase {
  title: string;
  intro?: string;
  steps: StepItem[];
  /** numbered — columns with large numbers; timeline — a vertical line. */
  variant?: "numbered" | "timeline";
  tone?: BlockTone;
}

export type FaqItem = { question: string; answer: string };
export interface FaqProps extends BlockBase {
  title: string;
  items: FaqItem[];
  /** accordion — answers open on click; columns — all answers visible in two columns. */
  variant?: "accordion" | "columns";
  tone?: BlockTone;
}

export interface CtaProps extends BlockBase {
  title: string;
  text?: string;
  action: BlockLink;
  secondary?: BlockLink;
  /** band — full-width stripe; card — a card in the middle of the page. */
  variant?: "band" | "card";
  tone?: BlockTone;
}

export type ContactItem = { label: string; value: string; href?: string };
export interface LeadFormProps extends BlockBase {
  /** Entity of the lead (the role needs create on it). */
  entity: string;
  title?: string;
  intro?: string;
  /** Fields of the form in order (default: every field the role may fill). */
  fields?: string[];
  /** Values sent without controls (source of the lead, chosen service). */
  hidden?: Record<string, unknown>;
  submitLabel?: string;
  /** Text after sending (default: «Спасибо! Мы получили вашу заявку.»). */
  successText?: string;
  /** card — form in a card; split — text and contacts left, form right; inline — form without a card. */
  variant?: "card" | "split" | "inline";
  /** Contacts next to the form (split). */
  contacts?: ContactItem[];
  aside?: ReactNode;
  tone?: BlockTone;
  onSuccess?(record: Record<string, unknown>): void;
}

export type FooterColumn = { title: string; links: BlockLink[] };
export interface FooterProps extends WzBase {
  brand: string;
  text?: string;
  columns?: FooterColumn[];
  contacts?: ContactItem[];
  /** Legal line as the owner gives it (operator name, ИНН); nothing is made up. */
  legal?: string;
  /** Link to the personal data policy page (default: shown when the system has one). */
  showPolicy?: boolean;
  /** simple — one row; columns — link columns and contacts. */
  variant?: "simple" | "columns";
}
