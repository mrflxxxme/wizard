// @wizard/runtime — hosting of generated systems (specs/runtime/runtime.yaml). Public API for platform-api,
// worker, gates (G1) and later runtime tasks.
export const APP = "@wizard/runtime";

/** Reserved system slugs (L3-29): shared by runtime routing and platform-api slug generation. */
export { isReservedSystemSlug, RESERVED_SYSTEM_SLUGS } from "@wizard/connectors";
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
/** Job runner (M1 minimal): workflow triggers, due _w_jobs, retention at a given `now`; cron helpers. */
export { type Cron, lastOccurrence, parseCron } from "./jobs/cron.js";
export {
  type JobFailure,
  type RetentionResult,
  type RunJobsOptions,
  type RunJobsReport,
  runJobs,
} from "./jobs/runner.js";
/** Schema app_<id>_<env>, migration helper (migration role only), system role sys_<id>_<env>_system (L3-20). */
export {
  dropSystemRole,
  ensureSystemRole,
  type MigrateOptions,
  migrateSystem,
  schemaName,
  systemRoleOf,
} from "./migrate.js";
/** Test-mode connector secrets for G1 runtimes (in-memory QR keyring). */
export { type SecretsFactory, testModeSecrets } from "./preview/connectors.js";
/** 152-ФЗ package (M2-05): erasure + deletion journal, policy facts, subject requests, legal template registry. */
export {
  type DeletionEntry,
  type DeletionMode,
  MAX_WITHDRAWAL_DAYS,
  type RevokeResult,
  retainUsers,
  revokeConsent,
  runDueErasures,
} from "./privacy/erasure.js";
export {
  DEFAULT_POLICY_PAGE,
  effectivePolicyPage,
  packageApplies,
  type RenderedPolicy,
  renderConsentText,
  renderPolicy,
  systemProcessors,
} from "./privacy/policy.js";
export {
  eraseSubject,
  exportSubject,
  findSubject,
  parseSubjectQuery,
  type SubjectExport,
  type SubjectQuery,
} from "./privacy/subject.js";
export {
  BUILTIN_TEMPLATES_DIR,
  DRAFT_MARK,
  defaultLegalTemplates,
  type LegalTemplate,
  LegalTemplateError,
  type LegalTemplateKind,
  LegalTemplates,
  loadLegalTemplates,
  parseLegalTemplate,
} from "./privacy/templates.js";
/** Deployment registry: DbRegistry (platform.deployments), FileRegistry (.data/artifacts/registry.json), MemoryRegistry. */
export {
  DbRegistry,
  FileRegistry,
  MemoryRegistry,
  parseRegistry,
  type RegistryEntry,
  type SystemEnv,
  type SystemRegistry,
} from "./registry.js";
/** RoleSpec for GET /_wizard/spec. */
export { buildRoleSpec, type RoleSpec } from "./rolespec.js";
/** M2 sandbox (security/isolation.yaml#M2): capability tokens {systemId, env, requestId, exp} of the runtime RPC. */
export {
  type Capability,
  type CapabilityCheck,
  issueCapability,
  newRequestId,
  type SandboxEnv,
  verifyCapability,
} from "./sandbox/capability.js";
/** Egress proxy: CONNECT :443 (SMTP :465/:587) to allowlisted public hosts, SNI = CONNECT host (L3-24). */
export {
  CONNECTOR_HOSTS,
  capabilityAuthorizer,
  createEgressProxy,
  type EgressPolicy,
  type EgressProxyOptions,
  egressPolicyFor,
  parseConnectTarget,
} from "./sandbox/egress.js";
/** Sandbox pod and NetworkPolicy manifests (gVisor RuntimeClass, non-root, read-only, no capabilities). */
export {
  SANDBOX_RUNTIME_CLASS,
  type SandboxPodInput,
  sandboxNetworkPolicy,
  sandboxPod,
} from "./sandbox/pod.js";
/** Grouping of systems into pods: Free and paid at most 10 per pod in separate pools; overflow is refused. */
export {
  DEFAULT_POOL_CONFIG,
  MAX_SYSTEMS_PER_POD,
  type Placement,
  SandboxConfigError,
  SandboxPool,
  type SandboxPoolConfig,
  SandboxPoolFullError,
  type SandboxPoolName,
  type SandboxSystem,
  type SandboxTier,
  validatePoolConfig,
} from "./sandbox/pool.js";
/** Runtime RPC listener of sandbox Workers: per-call capability tokens, 403 for forged/expired/foreign ones. */
export { type OpenCall, type OpenCallInput, SandboxRpc, type SandboxRpcOptions } from "./sandbox/rpc.js";
/** TLS ClientHello SNI peek (egress proxy). */
export { type HelloPeek, peekClientHello } from "./sandbox/sni.js";
/** workerd config of a pod: one Worker per system, globalOutbound deny-all, no nodejs_compat. */
export {
  WORKERD_COMPATIBILITY_DATE,
  WORKERD_COMPATIBILITY_FLAGS,
  WORKERD_V8_FLAGS,
  type WorkerdPodConfig,
  type WorkerdPodInput,
  type WorkerdSystem,
  workerdPodConfig,
} from "./sandbox/workerd-config.js";
/** Executor over sandbox pods (createRuntimeApp({sandbox})). */
export {
  createWorkerdSandbox,
  type GuestExecutor,
  type SandboxExecutors,
  WorkerdExecutor,
  type WorkerdExecutorOptions,
} from "./sandbox/workerd-executor.js";
/** Node server on 127.0.0.1:4100. */
export { type StartOptions, startRuntime } from "./server.js";
export { type LoadedSystem, type LoadSystemInput, SystemCache, SystemLoadError } from "./system.js";
/** Own Telegram bots at publication: getMe + setWebhook (live) or recorded calls (outbox). */
export {
  publishTelegramBots,
  type TelegramBotResult,
  type TelegramPublishOptions,
  type TelegramPublishSystem,
} from "./telegram-publish.js";
