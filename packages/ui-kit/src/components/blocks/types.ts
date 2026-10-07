// Props of the landing blocks (ui-kit.yaml#components, M2-43). Content always comes from the builder (the owner's facts);
// blocks add only structural texts (menu, policy link, form states).
import type { ReactNode } from "react";
import type { WzBase } from "../../data/context.js";
import type { ListQuery } from "../../data/types.js";
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
  /** bar — logo left, menu right; centered — logo above the menu; transparent — over the page, no bar or line. */
  variant?: "bar" | "centered" | "transparent";
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
  /** Pictures of the collage (2–3; the first one alone on phones). */
  images?: ImageSource[];
  /**
   * split — text and picture side by side; centered — text in the middle, picture below; cover — picture behind text;
   * minimal — a typographic poster without a picture; collage — text and 2–3 pictures with an offset.
   * Without pictures split and collage show the theme graphic.
   */
  variant?: "split" | "centered" | "cover" | "minimal" | "collage";
  tone?: Exclude<BlockTone, "alt">;
}

export type FeatureItem = { title: string; text?: string; image?: ImageSource; icon?: BlockIconName };
export interface FeaturesProps extends BlockBase {
  title: string;
  intro?: string;
  items: FeatureItem[];
  /**
   * grid — short points; cards — cards with pictures; alternating — picture and text rows in turn (the theme graphic
   * without a picture); icons — points with an icon in a tinted circle.
   */
  variant?: "grid" | "cards" | "alternating" | "icons";
  columns?: 2 | 3 | 4;
  tone?: BlockTone;
}

export type StepItem = { title: string; text?: string };
export interface StepsProps extends BlockBase {
  title: string;
  intro?: string;
  steps: StepItem[];
  /** numbered — columns with large numbers; timeline — a vertical line; cards — cards with a big outlined number. */
  variant?: "numbered" | "timeline" | "cards";
  tone?: BlockTone;
}

export type FaqItem = { question: string; answer: string };
export interface FaqProps extends BlockBase {
  title: string;
  intro?: string;
  items: FaqItem[];
  /** accordion — answers open on click; columns — all answers visible in two columns; split — title left, answers right. */
  variant?: "accordion" | "columns" | "split";
  tone?: BlockTone;
}

export interface CtaProps extends BlockBase {
  title: string;
  text?: string;
  action: BlockLink;
  secondary?: BlockLink;
  /** band — full-width stripe; card — a card in the middle of the page; split — text left, actions right on a band. */
  variant?: "band" | "card" | "split";
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
  /** simple — one row; columns — link columns and contacts; minimal — one centred line. */
  variant?: "simple" | "columns" | "minimal";
}

/** Decorative icons of the blocks (inline SVG, aria-hidden). */
export type BlockIconName =
  | "check"
  | "star"
  | "clock"
  | "shield"
  | "heart"
  | "leaf"
  | "spark"
  | "pin"
  | "phone"
  | "chat"
  | "calendar"
  | "gift";

export type GalleryItem = { caption?: string; image?: ImageSource };
export interface GalleryProps extends BlockBase {
  title?: string;
  intro?: string;
  /** Pictures with captions; without a picture a tile shows the theme graphic (photos come with B2-38). */
  items: GalleryItem[];
  /** grid — even tiles; masonry — tiles of different heights; carousel — a row swiped by hand (no autoplay). */
  variant?: "grid" | "masonry" | "carousel";
  tone?: BlockTone;
}

export type TeamMember = { name: string; role?: string; text?: string; image?: ImageSource };
export interface TeamProps extends BlockBase {
  title: string;
  intro?: string;
  /** People or roles as the owner names them; without a photo — a monogram on the theme graphic. */
  items: TeamMember[];
  /** cards — cards with a portrait; row — round portraits in a row; list — rows with a text. */
  variant?: "cards" | "row" | "list";
  tone?: BlockTone;
}

export type TestimonialItem = { text: string; author?: string; source?: string };
export interface TestimonialsProps extends BlockBase {
  title?: string;
  /** Reviews as the owner gives them (nothing is invented). */
  items: TestimonialItem[];
  /** cards — a grid of quotes; quote — one large quote (the first); carousel — a row swiped by hand. */
  variant?: "cards" | "quote" | "carousel";
  tone?: BlockTone;
}

export type StatItem = { value: string; label: string };
export interface StatsProps extends BlockBase {
  title?: string;
  /** Facts from the brief only (2–4). */
  items: StatItem[];
  /** row — numbers in a row with dividers; cards — numbers in cards; band — numbers on the brand colour. */
  variant?: "row" | "cards" | "band";
  tone?: BlockTone;
}

export interface AboutProps extends BlockBase {
  title: string;
  /** Text; paragraphs are separated by an empty line. */
  text: string;
  image?: ImageSource;
  /** split — text and picture side by side; centered — narrow text in the middle; story — title left, text right. */
  variant?: "split" | "centered" | "story";
  tone?: BlockTone;
}

export interface ContactsProps extends BlockBase {
  title: string;
  address?: string;
  phone?: string;
  email?: string;
  hours?: string;
  /** Messengers as «Telegram: @name» or links. */
  messengers?: string[];
  /**
   * card — contacts in a card; split — contacts and a map placeholder with «Открыть в Яндекс Картах» (no request to the
   * map service until the visitor follows the link); columns — contacts in columns.
   */
  variant?: "card" | "split" | "columns";
  tone?: BlockTone;
}

export type HoursItem = { day: string; time: string };
export interface HoursProps extends BlockBase {
  title?: string;
  /** Days and times («Пн–Пт», «10:00–20:00»). */
  items: HoursItem[];
  /** table — two columns; cards — a card per row; inline — one line. */
  variant?: "table" | "cards" | "inline";
  tone?: BlockTone;
}

export type LogoItem = { name: string; image?: ImageSource };
export interface LogosProps extends BlockBase {
  title?: string;
  /** Partners and clients by name (picture optional). */
  items: LogoItem[];
  /** row — one row; grid — tiles; marquee — a slow running line (still with prefers-reduced-motion). */
  variant?: "row" | "grid" | "marquee";
  tone?: BlockTone;
}

export interface TextBlockProps extends BlockBase {
  title?: string;
  /** Text; paragraphs are separated by an empty line. */
  text: string;
  /** plain — a narrow column; two_columns — two columns on large screens; quote — a large quotation. */
  variant?: "plain" | "two_columns" | "quote";
  tone?: BlockTone;
}

/** A field of a price row shown after the name: the value with a suffix («60 мин», «8 занятий»). */
export type PriceDetail = { field: string; suffix?: string };
export interface PricingProps extends BlockBase {
  /** Entity of the price rows (the role needs read on it). */
  entity: string;
  title: string;
  intro?: string;
  /** Small print under the prices (as the owner gives it). */
  note?: string;
  nameField?: string;
  priceField?: string;
  descriptionField?: string;
  details?: PriceDetail[];
  /** Query of the rows (filter of visible ones, sort). */
  query?: ListQuery;
  /** Action of every row (to the form or the booking). */
  action?: BlockLink;
  emptyText?: string;
  /** cards — tariff cards; table — a price list in rows; compact — name … price with dot leaders. */
  variant?: "cards" | "table" | "compact";
  tone?: BlockTone;
}

export interface BookingProps extends BlockBase {
  title: string;
  intro?: string;
  /** Where booking happens (the booking page). */
  action: BlockLink;
  /** Steps of booking shown next to the action (default: service, time, contacts). */
  steps?: string[];
  /** card — a card with steps; split — text left, steps and action right; inline — one band. */
  variant?: "card" | "split" | "inline";
  tone?: BlockTone;
}

export interface LandingSectionProps extends BlockBase {
  title: string;
  intro?: string;
  /** The page's main heading (h1) instead of a section heading (h2). */
  main?: boolean;
  tone?: BlockTone;
  /** Filter buttons above the content («Все» has id null); shown with two or more. */
  tabs?: { id: string | null; label: string }[];
  tab?: string | null;
  onTab?(id: string | null): void;
  children?: ReactNode;
}
