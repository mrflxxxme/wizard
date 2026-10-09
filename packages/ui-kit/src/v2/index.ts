/// <reference path="../css-modules.d.ts" />
// @wizard/ui-kit/v2 — platform design system v2 (ui-kit.yaml#platform_v2, B2-32, prototype E «Холст»).
// For the platform UI only (platform-web): generated systems keep the --w-* components of "@wizard/ui-kit".
// Global CSS: import "@wizard/ui-kit/v2/theme.css" once (fonts, --p-* tokens, base, grain, reduced motion).

/** V3-06 «Бриф»: BriefSummary (chat), BriefPanel (tabs, versions, diff), BriefDiagram (own layered SVG layout), BriefEditor, BriefDiffView, SessionsFeed. */
export {
  BRIEF_DIAGRAM_KEYS,
  BRIEF_EDITABLE_SECTIONS,
  BRIEF_LAYOUT,
  BriefDiagram,
  type BriefDiagramKey,
  type BriefDiagramProps,
  BriefDiffView,
  type BriefDiffViewProps,
  type BriefEditableSection,
  BriefEditor,
  type BriefEditorProps,
  BriefPanel,
  type BriefPanelProps,
  type BriefPanelTab,
  type BriefSession,
  BriefSummary,
  type BriefSummaryProps,
  type BriefVersionInfo,
  briefTheses,
  changedKeys,
  type GraphLayout,
  itemKey,
  type LaidEdge,
  type LaidNode,
  type LayoutOptions,
  layoutBriefGraph,
  overlaps,
  SESSION_KINDS,
  SESSION_STATUS_RU,
  SESSION_STATUSES,
  SessionsFeed,
  type SessionsFeedProps,
  sessionTitle,
  textWidth,
  wrapText,
} from "./components/brief/index.js";
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
/** Floating input row: block label, suggestions, breathing; V3-04 attach={onFile,…} — «Приложить ТЗ» (docx/pdf/md/txt ≤ 10 МБ). */
export {
  COMPOSER_ATTACH_ACCEPT,
  COMPOSER_ATTACH_MAX_BYTES,
  Composer,
  type ComposerAttach,
  type ComposerProps,
  type ComposerSuggestion,
} from "./components/Composer.js";
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
/** --p-* tokens: warm neutral palette, graphite + amber, business colour with safe contrast, CSS text, DOM apply (CSS variables, no <style>). */
export {
  applyPlatformTheme,
  type BusinessColors,
  businessColors,
  businessCss,
  businessVars,
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
