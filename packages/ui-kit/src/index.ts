/// <reference path="./css-modules.d.ts" />
// @wizard/ui-kit public API (specs/ui/ui-kit.yaml). Components import only from here in generated code.
export const PACKAGE = "@wizard/ui-kit";

export { AppShell, type AppShellProps, type NavItem } from "./components/AppShell.js";
export { Badge, type BadgeProps, type BadgeTone } from "./components/Badge.js";
export { Button, type ButtonProps } from "./components/Button.js";
/**
 * Landing blocks (M2-43, B2-35 section library v2): Header, Hero, Features, Steps, Faq, Cta, LeadForm (lead over
 * useCreate + consent), Footer, Gallery, Team, Testimonials, Stats, About, Contacts, Hours, Logos, TextBlock, Pricing
 * (prices from the system's data), Booking (to the booking page), LandingSection (frame of a module's section).
 */
export { About } from "./components/blocks/About.js";
export { Booking } from "./components/blocks/Booking.js";
export { Contacts } from "./components/blocks/Contacts.js";
export { Cta } from "./components/blocks/Cta.js";
export { Faq } from "./components/blocks/Faq.js";
export { Features } from "./components/blocks/Features.js";
export { Footer } from "./components/blocks/Footer.js";
export { Gallery } from "./components/blocks/Gallery.js";
export { Header } from "./components/blocks/Header.js";
export { Hero } from "./components/blocks/Hero.js";
export { Hours } from "./components/blocks/Hours.js";
export { LandingSection } from "./components/blocks/LandingSection.js";
export { LeadForm } from "./components/blocks/LeadForm.js";
export { Logos } from "./components/blocks/Logos.js";
export { Pricing } from "./components/blocks/Pricing.js";
export { Stats } from "./components/blocks/Stats.js";
export { Steps } from "./components/blocks/Steps.js";
export { Team } from "./components/blocks/Team.js";
export { Testimonials } from "./components/blocks/Testimonials.js";
export { TextBlock } from "./components/blocks/TextBlock.js";
export type {
  AboutProps,
  BlockIconName,
  BlockLink,
  BlockTone,
  BookingProps,
  ContactItem,
  ContactsProps,
  CtaProps,
  FaqItem,
  FaqProps,
  FeatureItem,
  FeaturesProps,
  FooterColumn,
  FooterProps,
  GalleryItem,
  GalleryProps,
  HeaderProps,
  HeroProps,
  HoursItem,
  HoursProps,
  LandingSectionProps,
  LeadFormProps,
  LogoItem,
  LogosProps,
  PriceDetail,
  PricingProps,
  StatItem,
  StatsProps,
  StepItem,
  StepsProps,
  TeamMember,
  TeamProps,
  TestimonialItem,
  TestimonialsProps,
  TextBlockProps,
} from "./components/blocks/types.js";
export { CabinetLayout } from "./components/CabinetLayout.js";
export { Catalog } from "./components/Catalog.js";
export { ConsentCheckbox } from "./components/ConsentCheckbox.js";
export { DataTable } from "./components/DataTable.js";
export { Field, type FieldProps, type FieldType } from "./components/Field.js";
export { FILE_MIMES, FileField, formatFileSize } from "./components/FileField.js";
export { GoalHints } from "./components/GoalHints.js";
export { ItemCard } from "./components/ItemCard.js";
export { Login } from "./components/Login.js";
/** Image of an image field (srcset of runtime variants 480/960/1600, lazy, alt required) or of the bundle (M2-47). */
export { Image, type ImageProps, type ImageRatio, type ImageSource } from "./components/media/Image.js";
/** Upload into an image field with a preview (RecordForm uses it for type=image). */
export { ImageField, type ImageFieldProps } from "./components/media/ImageField.js";
export { QrScanner } from "./components/QrScanner.js";
export { QrCode, QrTicket } from "./components/QrTicket.js";
export { RecordCard } from "./components/RecordCard.js";
export { RecordForm } from "./components/RecordForm.js";
/** V3-23 «Интернет-магазин» on the v2 front: goods with «В корзину», the cart, the checkout, the order's page. */
export {
  ShopCart,
  type ShopCartProps,
  ShopCheckout,
  type ShopCheckoutProps,
  ShopOrder,
  type ShopOrderProps,
  ShopProducts,
  type ShopProductsProps,
} from "./components/Shop.js";
export { EmptyState, ErrorState, Loading } from "./components/States.js";
export { StatsReport } from "./components/StatsReport.js";
export { StatusBoard } from "./components/StatusBoard.js";
export type {
  CabinetLayoutProps,
  CatalogProps,
  ColumnDef,
  ConsentCheckboxProps,
  DataTableProps,
  FileFieldProps,
  GoalHint,
  GoalHintsProps,
  ItemCardData,
  ItemCardProps,
  OptionGroup,
  QrScannerProps,
  QrTicketProps,
  RecordAction,
  RecordCardProps,
  RecordFormProps,
  ScanResult,
  Selection,
  StatsData,
  StatsReportProps,
  StatusBoardProps,
} from "./components/types.js";
export {
  useCan,
  useDataSource,
  useLocation,
  useNavigate,
  useRoleSpec,
  useWzUser,
  type WzBase,
  WzProvider,
  type WzProviderProps,
} from "./data/context.js";
export { toWzError } from "./data/mutation.js";
export {
  can,
  type LoginMethod,
  type RoleSpec,
  type RoleSpecCompliance,
  type RoleSpecOptions,
  toRoleSpec,
} from "./data/roleSpec.js";
export { sdkDataSource, toSdkListOptions } from "./data/sdk.js";
export type {
  AiActionResult,
  AsyncResult,
  AuthApi,
  DataSource,
  FileInfo,
  FileMimeType,
  FilesApi,
  ImageWidth,
  ListQuery,
  LoginConsent,
  Mutation,
  QrCheckRequest,
  QrCheckResponse,
  QrManifest,
  QrManifestEntry,
  QrOfflineApi,
  QrSyncEvent,
  QrSyncRequest,
  QrSyncResponse,
  QrSyncResult,
  Rec,
  UserResult,
  WriteOpts,
  WzError,
  WzUser,
} from "./data/types.js";
export * from "./format.js";
export { ru } from "./i18n/ru.js";
/** themeLint(theme) → plain-Russian notes (adjusted accent shades, unknown fonts) for the panel «Стиль» and the agent. */
export { type ThemeLintCode, type ThemeLintNote, themeLint } from "./themes/lint.js";
/** themeForNiche(«студия маникюра») → preset id for the agent (themes.yaml#selection). */
export { themeForNiche } from "./themes/niche.js";
/**
 * Ten theme presets v2 (themes.yaml, B2-36): id, Russian name and description, niches, defaults, neutrals, depth,
 * rhythm, heading style, photo style and theme graphic.
 */
export {
  THEME_PRESET_LIST,
  type ThemeGraphic,
  type ThemeNeutrals,
  type ThemePreset,
  type ThemePresetId,
  themePreset,
} from "./themes/presets.js";
/** Cabinet look v2 (B2-34): warm base + brand accents of a scheme (--w-cab-*), their names, the data-wz-look value. */
export { CABINET_LOOK, CABINET_TOKENS, cabinetTokens, cabinetValues } from "./tokens/cabinet.js";
export { blend, contrast, hexToOklch, luminance, oklchToHex } from "./tokens/color.js";
/** Self-hosted theme fonts (D64): catalog with license and source, @font-face for /_wizard/fonts. */
export {
  FONT_CATALOG,
  FONTS_BASE,
  type FontEntry,
  type FontFile,
  fontEntry,
  fontFaceCss,
  fontFiles,
  fontHasRuble,
  fontStack,
  RUBLE_FALLBACK_FONT,
} from "./tokens/fonts.js";
export {
  accentInk,
  accentStrong,
  accentText,
  applyTokens,
  PALETTE,
  type ResolvedTheme,
  resolveTheme,
  type Scheme,
  THEME_DEFAULTS,
  type ThemeInput,
  type TokenName,
  type Tokens,
  themeFonts,
  themeToTokens,
  tokensToCss,
  V2_TOKENS,
} from "./tokens/tokens.js";
/** V3-07 client design system (C2; React-free subpath ./v3/design): archetypes, sampler, tokens, CSS, designLint. */
export {
  ARCHETYPE_IDS,
  ARCHETYPES,
  type Archetype,
  type ArchetypeId,
  type ArchetypePick,
  DESIGN_THEME_CSS,
  type DesignDiversity,
  type DesignLintIssue,
  type DesignSystemInput,
  type DesignSystemV3,
  designDistance,
  designDiversity,
  designLint,
  designSystemCss,
  designSystemTheme,
  designSystemV3,
  pickArchetype,
  pickArchetypes,
} from "./v3/design/index.js";
