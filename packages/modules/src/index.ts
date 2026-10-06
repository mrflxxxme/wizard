export const PACKAGE = "@wizard/modules";

/** Module «Каталог и прайс»: manifest, compile hook (canonical names), showcase page (also the landing section). */
export {
  CATALOG_NAMES,
  type CatalogOptions,
  catalogOptions,
  compileCatalog,
  SHOWCASE,
  serviceFields,
} from "./catalog/compile.js";
export { catalogManifest, catalogModule } from "./catalog/index.js";
export {
  catalogShowcasePage,
  priceListColumns,
  type ShowcaseTarget,
  showcaseTarget,
} from "./catalog/page.js";
/** Beta v2 registry: MODULES (code where ready, drafts from specs/modules/modules.yaml#catalog), CATALOG, MODULES_WITH_CODE. */
export { CATALOG, MODULES, MODULES_WITH_CODE } from "./catalog.js";
/** Module «Клиенты с историей»: compile hook (tags, notes, lead → client workflow), lead sample data for G1 scenarios. */
export {
  CLIENT_CONTACTS,
  clientTagOptions,
  compileClientCard,
  leadSampleData,
} from "./client_card/compile.js";
/** «Клиенты и история» page: the card with notes and records of other modules that refer to the client. */
export { clientHistoryPage, type HistorySource, historySources } from "./client_card/history.js";
/** Module «Клиенты с историей»: manifest and definition. */
export { clientCardManifest, clientCardModule } from "./client_card/index.js";
/** «Воронка» page of «Воронка сделок»: StatusBoard by stage, the deal card and its tasks. */
export { dealsBoardPage } from "./deals/board.js";
/** Module «Воронка сделок»: compile hook (stages stage_1…N + won, lost), canonical stage options. */
export { compileDeals, DEAL_FINAL_STAGES, dealStages } from "./deals/compile.js";
/** Module «Воронка сделок»: manifest and definition. */
export { dealsManifest, dealsModule } from "./deals/index.js";
/** Draft manifests generated from modules.yaml#catalog (scripts/gen-draft.mjs). */
export { DRAFT_MANIFESTS } from "./draft.js";
/** compilePlan(plan, registry, {appName?}) → {ok, spec, files, order, links, metrics, scenarios, customSlots, plan, warnings} | {ok: false, errors}. */
export {
  BASE_ROLES,
  CABINET_ROUTE,
  type CompiledMetric,
  type CompiledScenario,
  type CompileOptions,
  type CompileResult,
  type CompileSuccess,
  type CustomSlot,
  checkRegistry,
  compiledFingerprint,
  compilePlan,
  unimplementedSections,
} from "./engine/compile.js";
/** matrixPlan(registry, moduleId, row) — the minimal plan a CI matrix row is compiled with. */
export { type MatrixRow, matrixPlan } from "./engine/matrix.js";
/** applicationOrder(manifests) — topological order by requires, then order, then id. */
export { applicationOrder } from "./engine/order.js";
/** substitute(value, params, known) — {{param}} substitution in fragment values; canonical JSON, sameJson. */
export { canonical, sameJson, substitute } from "./engine/substitute.js";
/** Module «Секции лендинга»: manifest, page generator, section renderers by type. */
export { landingManifest, landingModule } from "./landing/index.js";
export { landingPage, SECTION_ENTITY, SECTION_RENDERERS, sectionAnchors } from "./landing/page.js";
/** Module «Заявки»: manifest and compile hook. */
export { compileLeads, LEAD_STATUSES, leadFormFields } from "./leads/compile.js";
export { leadsManifest, leadsModule } from "./leads/index.js";
/** Shared page generators (also used by the D75 template): role cabinet, start page, permission helpers. */
export {
  cabinetPage,
  cabinetRoute,
  can,
  columns,
  permOf,
  startPage,
  statusField,
} from "./screens/cabinet.js";
/** Deterministic TSX emitters: jsxEl, fragmentPage, js, pascal. */
export { fragmentPage, type JsxAttr, js, jsxEl, pascal } from "./screens/jsx.js";
/** Module definition types: manifest + hook, screen generators, function sources; registry → ModuleCatalog. */
export {
  type ModuleContext,
  type ModuleDefinition,
  type ModuleRegistry,
  type ModuleScreen,
  planCatalog,
  type ScreenContext,
  type ScreenGenerator,
} from "./types.js";
