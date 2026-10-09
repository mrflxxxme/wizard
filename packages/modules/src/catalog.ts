// The beta v2 module registry: modules with code (src/<id>/) in place of their drafts from the spec's catalog.
// A new module: add src/<id>/index.ts with its ModuleDefinition and list it in MODULES_WITH_CODE.
import { bookingModule } from "./booking/index.js";
import { catalogModule } from "./catalog/index.js";
import { clientCardModule } from "./client_card/index.js";
import { contentModule } from "./content/index.js";
import { dealsModule } from "./deals/index.js";
import { DRAFT_MANIFESTS } from "./draft.js";
import { landingModule } from "./landing/index.js";
import { leadsModule } from "./leads/index.js";
import { notifyModule } from "./notify/index.js";
import { packagesModule } from "./packages/index.js";
import { reportsModule } from "./reports/index.js";
import { resourcesModule } from "./resources/index.js";
import { shopModule } from "./shop/index.js";
import { staffModule } from "./staff/index.js";
import type { ModuleDefinition, ModuleRegistry } from "./types.js";
import { visitorCabinetModule } from "./visitor_cabinet/index.js";

/** Modules with code (status ready). */
export const MODULES_WITH_CODE: readonly ModuleDefinition[] = [
  landingModule,
  leadsModule,
  catalogModule,
  clientCardModule,
  dealsModule,
  notifyModule,
  reportsModule,
  staffModule,
  visitorCabinetModule,
  bookingModule,
  packagesModule,
  resourcesModule,
  contentModule,
  shopModule,
];

const withCode = new Map(MODULES_WITH_CODE.map((d) => [d.manifest.id, d]));

/** All catalog modules in the spec's order: code where it exists, else the draft manifest. */
export const MODULES: readonly ModuleDefinition[] = DRAFT_MANIFESTS.map(
  (m) => withCode.get(m.id) ?? { manifest: m },
);

/** The registry compilePlan uses by default (themes, fonts and sections — the appspec defaults). */
export const CATALOG: ModuleRegistry = { modules: MODULES };
