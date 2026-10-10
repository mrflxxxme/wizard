// @wizard/ui-kit/v3/design (builder-v3.md#C2, V3-07): the client's design system without React — archetypes as data,
// the seeded sampler with niche memory, tokens computed by code, CSS with the Tailwind v4 theme, designLint and the
// diversity metric. Server code (the art director, the build) and the browser use the same functions.

/** 14 archetypes of the art director: Russian name, reason, font pairs (D64), palette, type, grid, motion, imagery rules. */
export {
  type AccentUse,
  ARCHETYPE_IDS,
  ARCHETYPES,
  type Archetype,
  type ArchetypeId,
  archetype,
  type DesignVoice,
  type FontPair,
  type GoalTag,
  isArchetypeId,
  type PaletteRules,
  type SystemClass,
} from "./archetypes.js";
/** cabinetTokensV3(ds, scheme) → the --w-cab-* tokens of staff cabinets in the client's style (V3-12). */
export { type CabinetTokenName, cabinetTokensV3, cabinetValuesV3 } from "./cabinet.js";
/**
 * designSystemCss(ds) → --ds-* variables of both schemes, reduced motion, keyframes, the fit rules of display words
 * (FIT_WORDS_CSS: data-fit-words keeps a brand's longest word on one line of a phone) and the Tailwind `@theme inline`.
 */
export {
  colorVar,
  DESIGN_THEME_CSS,
  type DesignCssOptions,
  designSystemCss,
  designSystemVars,
  FIT_WORDS_CSS,
  FIT_WORDS_MAX,
  PATTERN_COLOR_ROLES,
  PATTERN_TEXT_STEPS,
} from "./css.js";
/** designDistance / designDiversity: how different design systems are (V3-07 acceptance, template gate input). */
export { type DesignDiversity, designDistance, designDiversity, designKey } from "./diversity.js";
/** Font roles of v3 (catalog A3): display-only, never-display, needs-a-reason and forbidden faces; FONT_ADVANCE per face. */
export {
  cyrillicFace,
  DISPLAY_ONLY_FONTS,
  FONT_ADVANCE,
  FORBIDDEN_FONTS,
  fontAdvance,
  NEEDS_REASON_FONTS,
  NOT_DISPLAY_FONTS,
} from "./fonts.js";
/** designLint(ds) → contrast AA in both schemes, Cyrillic fonts, banned defaults, type, motion; errors block. */
export { type DesignLintCode, type DesignLintIssue, designLint, designLintErrors } from "./lint.js";
/** OKLCH palette from the brand colour: roles, `oklch()` ⇄ hex, the C02 cream check. */
export {
  buildPalette,
  COLOR_ROLES,
  type ColorRole,
  cssHex,
  isCream,
  normalizeBrand,
  oklchCss,
  type PaletteScheme,
  type PaletteV3,
  parseOklch,
  type SchemeName,
  schemeHex,
} from "./palette.js";
/** pickArchetype({niche, goals, seed, recent}) — seeded sampler with niche memory; pickArchetypes(…, 3) — distinct. */
export {
  type ArchetypePick,
  archetypeFit,
  GOAL_STEMS,
  goalTags,
  NICHE_MEMORY,
  type PickInput,
  pickArchetype,
  pickArchetypes,
  systemClasses,
} from "./pick.js";
/** designSystemV3({archetype, brandColor?, seed, niche, voice}) → DesignSystemV3; designSystemTheme → AppSpec.theme. */
export {
  type DesignSystemInput,
  type DesignSystemV3,
  designSystemTheme,
  designSystemV3,
  type FontChoice,
  fluid,
  RADIUS_SETS,
  SECTION_SPACE,
  TYPE_STEPS,
  type TypeStep,
} from "./system.js";
