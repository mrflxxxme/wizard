export const PACKAGE = "@wizard/modules";

/** Module «Запись по слотам»: manifest, statuses, the catalog contract, schedule constants and generated helpers. */
export {
  ACTIVE_STATUSES,
  BOOKING_STATUSES,
  compileBooking,
  linkRules,
  SERVICE_CONTRACT,
} from "./booking/compile.js";
export { bookingManifest, bookingModule } from "./booking/index.js";
export { bookingPage } from "./booking/page.js";
export { type ScheduleSpec, scheduleOf, scheduleSource, scheduleWarnings } from "./booking/schedule.js";
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
export { compileLeads, LEAD_STATUSES, leadFormFields, visitorLeadContact } from "./leads/compile.js";
export { leadsManifest, leadsModule } from "./leads/index.js";
/** Module «Напоминания и уведомления» (B2-16): manifest, hook (integrations, workflows, G1 scenarios), booking contract. */
export {
  BOOKING_CONSENT_FIELD,
  compileNotify,
  NOTIFY_BOOKING,
  NOTIFY_MAIL,
  NOTIFY_TG,
  type NotifyItem,
  type NotifyPlan,
  notifyPlan,
  SCENARIO_LEAD,
} from "./notify/compile.js";
export { notifyManifest, notifyModule, notifyScreen } from "./notify/index.js";
/** Module «Абонементы и пакеты» (B2-18): tariffs, client packages, write-off by booking, members' materials. */
export {
  BOOKING_PACKAGE_STATUSES,
  compilePackages,
  PACKAGE_NAMES,
  PACKAGE_SAMPLE,
  type PackageKind,
  packageKind,
  packageStatuses,
  USAGE_KINDS,
  visitorPackageContact,
  writesOff,
} from "./packages/compile.js";
export { packagesManifest, packagesModule } from "./packages/index.js";
export { materialsPage } from "./packages/materials.js";
export { DIGEST_CRON, reportsManifest, reportsModule } from "./reports/index.js";
/** Module «Отчёты и панель цели»: manifest, goal-panel model (tiles, sources, reports), goalMetrics query and page. */
export {
  type EntityReport,
  type MetricCompute,
  type MetricUnit,
  type Period,
  periodWindows,
  type Row,
  trendOf,
  type Windows,
} from "./reports/lib/goalPanel.js";
export { GOAL_PANEL_LIB } from "./reports/lib-source.js";
export { goalPanelPage, goalPanelSource, PANEL_VIEW, PERIODS, tileGroups } from "./reports/page.js";
export {
  MAX_TILES,
  MIN_TILES,
  PANEL_ROLE,
  type PanelModel,
  type PanelReport,
  type PanelSource,
  type PanelTile,
  panelModel,
  pickTiles,
  ROW_BUDGET,
} from "./reports/panel.js";
export {
  GOAL_METRICS_FILE,
  GOAL_METRICS_FN,
  type GoalMetricsResult,
  goalMetricsFile,
  goalMetricsSource,
} from "./reports/query.js";
/** Module «Учёт выдачи и ресурсов» (B2-18): items and issues, return, overdue mark, list import from a spreadsheet. */
export {
  compileResources,
  ISSUE_STATUSES,
  RESOURCE_NAMES,
  RESOURCE_SAMPLE,
  resourceStatuses,
} from "./resources/compile.js";
export { IMPORT_MAX_ROWS, importColumns, importPage } from "./resources/import.js";
export { resourcesManifest, resourcesModule } from "./resources/index.js";
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
/** Module «Сотрудники и роли» (B2-16): roles staff…staff_5 with sections, the scope of $staff, invitations page. */
export {
  compileStaff,
  STAFF_ROLE_NAMES,
  STAFF_SECTIONS,
  type StaffRole,
  staffLoginMethods,
  staffRoles,
  staffRolesFor,
} from "./staff/compile.js";
export { staffManifest, staffModule, staffScreen, TEAM_PAGE } from "./staff/index.js";
/** Module definition types: manifest + hook, screen generators, function sources; registry → ModuleCatalog. */
export {
  type FileGenerator,
  type GenContext,
  type ModuleContext,
  type ModuleDefinition,
  type ModuleRegistry,
  type ModuleScreen,
  planCatalog,
  type ScreenContext,
  type ScreenGenerator,
} from "./types.js";
/** Module «Кабинет посетителя» (B2-16): the visitor role and /me with his own rows (rowFilter of the data modules). */
export {
  VISITOR_SECTIONS,
  visitorCabinetManifest,
  visitorCabinetModule,
  visitorContact,
  visitorScreen,
} from "./visitor_cabinet/index.js";
