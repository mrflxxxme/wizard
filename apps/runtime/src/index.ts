// @wizard/runtime — hosting of generated systems (specs/runtime/runtime.yaml). Public API for platform-api,
// worker, gates (G1) and later runtime tasks.
export const APP = "@wizard/runtime";

/** createRuntimeApp({db, registry, clock?, connectors?}) → {fetch, loadSystem, outbox} (interfaces.runtime_handle). */
export { createRuntimeApp, type RuntimeApp, type RuntimeAppOptions } from "./app.js";
/** Tokens of the session cookie; safeNext for next/returnTo (runtime.yaml#auth). */
export {
  previewCookieName,
  readSessionToken,
  SESSION_TTL_MS,
  safeNext,
  sessionCookieName,
} from "./auth/session.js";
/** Consent hashes exposed in RoleSpec.compliance. */
export { type ComplianceInfo, complianceInfo, consentMatches } from "./compliance.js";
/** DataAccess contract: data API + ctx.db/ctx.systemDb (architecture.yaml#interfaces.data_access). */
export * from "./data/access.js";
/** In-process invalidation bus (M0). */
export { createInvalidationBus } from "./data/events.js";
/** DataAccess over Postgres with RLS context (set_config(..., true)). */
export { createPgDataAccess, type PgDataAccessOptions } from "./data/pg.js";
/** Process env and dev-only startup guards (L3-10, L3-11). */
export { assertStartupAllowed, isLoopbackAddress, type RuntimeEnv, readEnv, StartupError } from "./env.js";
/** Isolated function executor (unsafe-local, M0–M1): stop all executor processes on shutdown. */
export { closeExecutors } from "./exec/host.js";
/** Hono env for route modules in src/routes/* (M0-23, M0-24). */
export type { OutboxMessage, RuntimeContext, RuntimeHonoEnv, RuntimeServices } from "./http/context.js";
/** JSON error body (runtime.yaml#data_api.error_shape). */
export { errorResponse } from "./http/errors.js";
/** Request → Subject of the current session. */
export { sessionOf, subjectOf } from "./http/subject.js";
/** Schema name app_<systemId>_<env> and a migration helper for previews/G1/tests (migration role only). */
export { type MigrateOptions, migrateSystem, schemaName } from "./migrate.js";
/** Deployment registry: FileRegistry (.data/artifacts/registry.json), MemoryRegistry. */
export {
  FileRegistry,
  MemoryRegistry,
  parseRegistry,
  type RegistryEntry,
  type SystemEnv,
  type SystemRegistry,
} from "./registry.js";
/** RoleSpec for GET /_wizard/spec. */
export { buildRoleSpec, type RoleSpec } from "./rolespec.js";
/** Node server on 127.0.0.1:4100. */
export { type StartOptions, startRuntime } from "./server.js";
export { type LoadedSystem, type LoadSystemInput, SystemCache, SystemLoadError } from "./system.js";
