/// <reference path="../css-modules.d.ts" />
// @wizard/ui-kit/v2 — platform design system v2 (ui-kit.yaml#platform_v2, B2-32, prototype E «Холст»).
// For the platform UI only (platform-web): generated systems keep the --w-* components of "@wizard/ui-kit".
// Global CSS: import "@wizard/ui-kit/v2/theme.css" once (fonts, --p-* tokens, base, grain, reduced motion).

/** Canvas block: sketch → «материализация» (outline → surface → content, amber edge) → ready; selectable. */
export {
  CanvasBlock,
  type CanvasBlockProps,
  type CanvasBlockState,
  SketchText,
  type SketchTextProps,
} from "./components/CanvasBlock.js";
/** Floating chat bottom-centre / pull-up sheet on the phone; history lines. */
export {
  ChatMessage,
  type ChatMessageProps,
  ChatSheet,
  type ChatSheetProps,
  SHEET_DRAG_THRESHOLD,
} from "./components/ChatSheet.js";
/** Floating input row: selected block label, suggestions, breathing while the AI thinks. */
export { Composer, type ComposerProps, type ComposerSuggestion } from "./components/Composer.js";
/** Buttons, chips, tags, serif «human» text, glass panel and the theme root. */
export {
  ActionButton,
  type ActionButtonProps,
  Chip,
  type ChipProps,
  Glass,
  type GlassProps,
  Serif,
  type SerifProps,
  Tag,
  type TagProps,
  ThemeRoot,
  type ThemeRootProps,
} from "./components/controls.js";
/** Question card with options and the recommended one. */
export { QuestionCard, type QuestionCardProps, type QuestionOption } from "./components/QuestionCard.js";
/** X-ray layer «Как это работает»: numbered steps and lines; wirePath is the pure path maker. */
export {
  wirePath,
  XrayLines,
  type XrayLinesProps,
  type XrayNode,
  type XrayPoint,
} from "./components/XrayLines.js";
/** Platform fonts (Inter, Source Serif 4): license and source per family (D64). */
export { PLATFORM_FONTS } from "./font-catalog.js";
/** --p-* tokens: warm neutral palette, graphite + amber, business colour with safe contrast, CSS text, DOM apply. */
export {
  applyPlatformTheme,
  type BusinessColors,
  businessColors,
  businessCss,
  DEMO_BUSINESS_COLOR,
  MATERIALIZE_MS,
  PLATFORM_COLORS,
  PLATFORM_CONSTANTS,
  PLATFORM_ROOT,
  type PlatformColor,
  type PlatformScheme,
  type PlatformThemeMode,
  type PlatformThemeOptions,
  type PlatformTokenName,
  type PlatformTokens,
  platformThemeCss,
  platformTokens,
  rgba,
} from "./tokens.js";
/** True when the user asked for less motion. */
export { prefersReducedMotion } from "./util.js";
