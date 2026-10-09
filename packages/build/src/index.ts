// @wizard/build — specs/architecture.yaml#interfaces.build_system.
export const PACKAGE = "@wizard/build";

export { type WrittenArtifact, writeArtifact } from "./artifact.js";
export {
  BUILD_CHECK_ID,
  buildSystem,
  defaultHostModules,
  defaultV3HostModules,
  SYSTEM_BUNDLE_LIMIT,
  UI_BUNDLE_LIMIT,
} from "./build.js";
export { canonicalJson, sha256Hex, specHash } from "./hash.js";
/**
 * Per-route SEO of v3 pages (V3-12): ui/seo.json → the home page's title, description and Open Graph tags in index.html,
 * the current route's tags set by the client on navigation.
 */
export {
  parseSeo,
  SEO_PATH,
  type SeoPage,
  type SiteSeo,
  seoClientCode,
  seoHeadTags,
  seoTitle,
} from "./seo.js";
/**
 * Tailwind v4 of v3 systems (builder-v3.md §1): ui/design.css switches it on; candidates from string literals of
 * ui/pages|patterns|sections; the ui-kit CSS sits in layer «wizard» between preflight and utilities.
 */
export {
  compileTailwind,
  DESIGN_CSS_PATH,
  isTailwindSystem,
  KIT_LAYER,
  layeredCss,
  systemTailwind,
  TAILWIND_SOURCE_RE,
  type TailwindResult,
  tailwindCandidates,
} from "./tailwind.js";
export { type SystemTsconfig, systemTsconfig, TSCONFIG_SYSTEM_PATH } from "./tsconfig.js";
export type {
  BuildEnv,
  BuildInput,
  BuildManifest,
  BuildResult,
  Check,
  HostModules,
  V3HostModules,
} from "./types.js";
export { fileKey, injectWzIds, type WzEntry, type WzMap, type WzTransform } from "./wz-id.js";
