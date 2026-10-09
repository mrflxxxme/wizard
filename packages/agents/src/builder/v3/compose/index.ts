// The page writer of the builder v3 (V3-12; builder-v3.md §3 C6): implements PageComposer for the harness (V3-11).
// skeleton — the whole public site from library patterns, the facts and the design system, without a model;
// scenario — one brief scenario brought to its page(s) by the models page_compose and signature_section, checked by
// the anti-slop linter, lintPattern and the G0 build before it returns.
import type { BriefScenario } from "@wizard/appspec";
import type { PageComposer, V3BuildContext, V3ComposeResult } from "../contract.js";
import { siteFiles } from "./codegen.js";
import { type ComposeScenarioOptions, composeScenario } from "./scenario.js";
import { pagePlans } from "./site.js";
import { type ComposeLibrary, composeSite } from "./skeleton.js";

export interface PageComposerOptions extends ComposeLibrary, ComposeScenarioOptions {}

/** The page composer of V3-12. */
export function createPageComposer(opts: PageComposerOptions = {}): PageComposer {
  return {
    async skeleton(ctx: V3BuildContext): Promise<V3ComposeResult> {
      const r = composeSite(ctx, opts);
      const files = r.site.pages.length
        ? siteFiles(r.site, r.facts.name, ctx.design, ctx.files, new Map(), opts.patterns)
        : new Map<string, string | null>();
      return { files, pages: pagePlans(r.site), notes: r.notes, spentRub: 0 };
    },
    scenario(ctx: V3BuildContext, scenario: BriefScenario): Promise<V3ComposeResult> {
      return composeScenario(ctx, scenario, opts);
    },
  };
}

export {
  DESIGN_CSS,
  designCss,
  pageSource,
  SEO_JSON,
  sectionComponent,
  seoJson,
  siteFiles,
} from "./codegen.js";
export { actionHref, primaryAction, type SiteAction, sectionProps, seoOf } from "./content.js";
export { numbersOf, type SiteFacts, type SitePhoto, siteFacts, textLeaves } from "./facts.js";
export {
  type CopyIssue,
  copyIssues,
  headingLevels,
  type LintPageInput,
  type LintSection,
  lintErrors,
  lintPage,
  type PageLintCode,
  type PageLintIssue,
  propsIssues,
  STOP_WORDS,
  sectionOutline,
} from "./lint.js";
export {
  COMPOSE_CALL_TYPES,
  type ComposeScenarioOptions,
  composeScenario,
  type PageComposeAnswer,
  pageComposeMessages,
  pageComposeRequest,
  pageComposeSchema,
  type ScenarioVerify,
  type SignatureAnswer,
  signatureMessages,
  signatureOffer,
  signatureRequest,
  signatureSchema,
  verifySystem,
} from "./scenario.js";
export {
  ANCHOR_LABELS,
  bindingOf,
  componentOf,
  MAX_SIGNATURES,
  PAGE_SECTIONS,
  type PageKind,
  type PlannedPage,
  pageKind,
  pagePlans,
  plannedPages,
  readSite,
  SECTIONS_DIR,
  type SeoMeta,
  SITE_PAGES_DIR,
  SITE_PATH,
  type SiteModel,
  type SitePage,
  type SiteSection,
  withSitePages,
} from "./site.js";
export {
  type ComposeLibrary,
  choosePattern,
  composeSite,
  lintSitePage,
  type SkeletonResult,
} from "./skeleton.js";
