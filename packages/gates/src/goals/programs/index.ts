// Programs of goal scenarios by scenario id (GS-<module>-<n>, modules.yaml#manifest.goal_scenarios). A ready module's
// scenario without a program is reported by G1 as «не связан с проверкой» (error, blocker). A new module: add
// programs/<module>.ts with its programs and spread it here.
import type { GoalProgram } from "../types.js";
import { LANDING_PROGRAMS } from "./landing.js";
import { LEADS_PROGRAMS } from "./leads.js";
import { PACKAGES_PROGRAMS } from "./packages.js";
import { RESOURCES_PROGRAMS } from "./resources.js";

export const GOAL_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  ...LANDING_PROGRAMS,
  ...LEADS_PROGRAMS,
  ...PACKAGES_PROGRAMS,
  ...RESOURCES_PROGRAMS,
};
