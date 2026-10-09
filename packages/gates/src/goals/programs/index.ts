// Programs of goal scenarios by scenario id (GS-<module>-<n>, modules.yaml#manifest.goal_scenarios). A ready module's
// scenario without a program is reported by G1 as «не связан с проверкой» (error, blocker). A new module: add
// programs/<module>.ts with its programs and spread it here.
import type { GoalProgram } from "../types.js";
import { BOOKING_PROGRAMS } from "./booking.js";
import { CATALOG_PROGRAMS } from "./catalog.js";
import { CLIENT_CARD_PROGRAMS } from "./client_card.js";
import { CONTENT_PROGRAMS } from "./content.js";
import { DEALS_PROGRAMS } from "./deals.js";
import { LANDING_PROGRAMS } from "./landing.js";
import { LEADS_PROGRAMS } from "./leads.js";
import { NOTIFY_PROGRAMS } from "./notify.js";
import { PACKAGES_PROGRAMS } from "./packages.js";
import { REPORTS_PROGRAMS } from "./reports.js";
import { RESOURCES_PROGRAMS } from "./resources.js";
import { STAFF_PROGRAMS } from "./staff.js";
import { VISITOR_CABINET_PROGRAMS } from "./visitor_cabinet.js";

export const GOAL_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  ...LANDING_PROGRAMS,
  ...LEADS_PROGRAMS,
  ...CATALOG_PROGRAMS,
  ...CLIENT_CARD_PROGRAMS,
  ...DEALS_PROGRAMS,
  ...NOTIFY_PROGRAMS,
  ...REPORTS_PROGRAMS,
  ...STAFF_PROGRAMS,
  ...VISITOR_CABINET_PROGRAMS,
  ...BOOKING_PROGRAMS,
  ...PACKAGES_PROGRAMS,
  ...RESOURCES_PROGRAMS,
  ...CONTENT_PROGRAMS,
};
