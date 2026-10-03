// @wizard/runtime — hosting of generated systems (specs/runtime/runtime.yaml). Public API for platform-api,
// worker, gates (G1) and later runtime tasks.
export const APP = "@wizard/runtime";

/** Reserved system slugs (L3-29): shared by runtime routing and platform-api slug generation. */
export { isReservedSystemSlug, RESERVED_SYSTEM_SLUGS } from "@wizard/connectors";
/** AI actions (runtime.yaml#ai_actions, M3-02): run on a record, `_aiFilled` meta, one-time backfill. */
export {
  AI_FILL_OP,
  type AiRunOutcome,
  aiFilledFields,
  type BackfillReport,
  backfillAiAction,
  findAiAction,
  runAiAction,
} from "./ai/actions.js";
/** Client of the platform AI gateway (POST /internal/v1/ai/run, X-Wizard-Internal-Token). */
export {
  type AiGatewayClient,
  type AiRunRequest,
  type AiRunResponse,
  httpAiGateway,
} from "./ai/gateway.js";
/** createRuntimeApp({db, registry, clock?, connectors?}) → {fetch, loadSystem, outbox} (interfaces.runtime_handle). */
export {
  createRuntimeApp,
  type RetentionTickReport,
  type RuntimeApp,
  type RuntimeAppOptions,
} from "./app.js";
/** Preview-login tokens (runtime.yaml#auth.preview_login_M2, L3-11): issued by platform-api, verified by the runtime. */
export {
  issuePreviewToken,
  newPreviewNonce,
  PREVIEW_SECRET_MIN_BYTES,
  PREVIEW_TOKEN_TTL_MS,
  type PreviewCheck,
  type PreviewClaims,
  verifyPreviewToken,
} from "./auth/preview-token.js";
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
/** Process env and dev-only startup guards (L3-10, L3-11); cloud drafts open only via preview-login. */
export {
  assertStartupAllowed,
  draftPreviewOnly,
  isLoopbackAddress,
  type RuntimeEnv,
  readEnv,
  StartupError,
} from "./env.js";
/** Isolated function executor (unsafe-local, M0–M1): stop all executor processes on shutdown. */
export { closeExecutors } from "./exec/host.js";
/** AWS SigV4 (header-signed requests, presigned URLs) for the S3-compatible store. */
export { EMPTY_SHA256, presignUrl, type S3Credentials, type SignInput, signRequest } from "./files/sigv4.js";
/** M2-14 files (runtime.yaml#files): magic-byte allowlist, attachment headers. */
export {
  attachmentDisposition,
  FILE_MIMES,
  type FileMime,
  MAX_FILE_BYTES,
  safeFileName,
  sniffMime,
} from "./files/sniff.js";
/** Object storage of file fields: S3 (Cloud.ru), local folder, memory; env-driven factory; purge of a schema prefix. */
export {
  createFileStorage,
  FILE_KEY_RE,
  type FileMeta,
  type FileStorage,
  FsFileStorage,
  MemoryFileStorage,
  purgeSchemaFiles,
  type S3Config,
  S3Error,
  S3FileStorage,
  type StoredFile,
} from "./files/storage.js";
/** Files of a loaded system: attach guard, release of detached files, sweep of abandoned uploads. */
export {
  ABANDONED_UPLOAD_MS,
  FILE_NOT_FOUND_RU,
  type FileFieldGuard,
  SystemFiles,
} from "./files/system-files.js";
/** Hono env for route modules in src/routes/* (M0-23, M0-24). */
export type { OutboxMessage, RuntimeContext, RuntimeHonoEnv, RuntimeServices } from "./http/context.js";
/** JSON error body (runtime.yaml#data_api.error_shape). */
export { errorResponse } from "./http/errors.js";
/** Request → Subject of the current session. */
export { sessionOf, subjectOf } from "./http/subject.js";
/** Internal port handler (health details, /_wizard/internal/reload, egress-authorize, sandbox RPC; L3-19). */
export { createInternalHandler, type InternalOptions, internalTokenOk } from "./internal.js";
/** Job runner (M1 minimal): workflow triggers, due _w_jobs, retention at a given `now`; cron helpers. */
export { type Cron, lastOccurrence, parseCron } from "./jobs/cron.js";
export {
  type JobFailure,
  RETENTION_MARKER_KEY,
  RETENTION_REQUEST_KEY,
  type RetentionPassReport,
  type RetentionResult,
  type RunJobsOptions,
  type RunJobsReport,
  retentionSlot,
  runJobs,
} from "./jobs/runner.js";
/** M2-09: Prometheus metrics of the runtime (public port requests, retention passes); served on StartOptions.metricsPort. */
export { instrumentFetch, runtimeMetrics } from "./metrics.js";
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
/** POST /api/ai/:action: public-role limit per client network and hour (L3-41). */
export { AI_PUBLIC_PER_HOUR } from "./routes/ai.js";
/** /api/files: lifetime of signed download links, uploads per hour. */
export { FILE_LINK_TTL_MS, UPLOADS_PER_HOUR } from "./routes/files.js";
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
/** authorize() of the egress-proxy deployment: capability check delegated to the runtime's internal port. */
export { type RemoteAuthorizerOptions, remoteCapabilityAuthorizer } from "./sandbox/egress-remote.js";
/** M2-18: sandbox of a process from its env (WIZARD_SANDBOX=k8s) and the capability key. */
export { sandboxFromEnv, sandboxKey } from "./sandbox/from-env.js";
/** M2-18: in-cluster Kubernetes API of the orchestrator (pods and ConfigMaps of one namespace). */
export { inClusterSend, type KubeApi, KubeError, type KubePodStatus, kubeApi } from "./sandbox/kube.js";
/** M2-18: places systems into workerd pods (ConfigMap + pod per config hash) and serves their executors. */
export { type OrchestratorOptions, type PrepareInput, SandboxOrchestrator } from "./sandbox/orchestrator.js";
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
