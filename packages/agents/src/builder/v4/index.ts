// Public API of the role pipeline (V5-03).
export { concreteShare, slopIssues, slopReasons } from "./antislop.js";
export { homeSource, recordPath, V5_DIR, V5_SIGNATURE_FILE } from "./page.js";
export {
  pageFiles,
  type RolesDeps,
  RolesFailure,
  type RolesRender,
  type RolesResult,
  runRoles,
} from "./pipeline.js";
export type { RolesInput } from "./prompts.js";
export { pageIssues, resolveAfter, signatureSourceIssues } from "./roles.js";
export * from "./types.js";
