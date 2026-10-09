// @wizard/agents/integrations (V3-20; D77_v3 (15), D37): documentation → contract (subset of OpenAPI 3.1, field mapping,
// allowed hosts, secret://) → typed client of the system → deterministic mock and contract tests → the key check.
/** Contract schema and helpers: parse, sha256, contractRef contract://<id>@<version>#<sha12>, limits. */

/** Requests, the deterministic mock, contract tests and the key check. */
export {
  buildRequest,
  type ContractTestReport,
  checkContractKey,
  type IntegrationRequest,
  type IntegrationResponse,
  type IntegrationTransport,
  type KeyCheckCode,
  type KeyCheckResult,
  mockBody,
  mockTransport,
  type OperationInput,
  type OperationResult,
  operationOf,
  runContractTests,
  sampleInput,
} from "./client.js";
/** Typed client code of the system (functions/integrations/<id>/**), mock or live mode. */
export {
  argOf,
  contractSecretName,
  generatable,
  INTEGRATION_FILE_RE,
  type IntegrationCode,
  type IntegrationMode,
  integrationCode,
  integrationDir,
  integrationFunctionName,
  type SpecFunction,
  tsType,
} from "./codegen.js";
export {
  ARG_RE,
  CONTRACT_AUTH_KINDS,
  CONTRACT_FORMAT,
  CONTRACT_KEY_KINDS,
  CONTRACT_LIMITS,
  CONTRACT_METHODS,
  ContractInvalidError,
  type ContractMapping,
  type ContractMethod,
  type ContractOperation,
  type ContractParam,
  contractHash,
  contractRef,
  defaultSecretRef,
  type IntegrationContract,
  integrationContractSchema,
  OPERATION_ID_RE,
  parseContract,
  parseContractRef,
  secretName,
} from "./contract.js";
/** Documentation link → contract (discover_docs → OpenAPI, else read_page → prose). */
export { contractFromDocs, type DocsContractInput, type DocsContractResult } from "./docs.js";
/** D37: integration functions reach only their contract's hosts with only its key. */
export { type EgressIssue, integrationEgressIssues } from "./egress.js";
/** The layer of a build: contracts of the brief's integrations → code and functions, notes. */
export {
  type IntegrationLayer,
  type IntegrationsHookResult,
  integrationLayer,
  integrationsHook,
  type StoredContract,
  withIntegrationLayer,
} from "./layer.js";
/** Field mapping by names and synonyms (Russian and English). */
export { type MappingEntity, mapFields } from "./mapping.js";
/** OpenAPI 3.x / Swagger 2.0 → contract by code (operations by the need, auth, safe GET for the check). */
export {
  camelIdent,
  contractFromOpenApi,
  DEFAULT_OPERATIONS,
  type FromOpenApiOptions,
  needWords,
  OpenApiImportError,
  pickCheck,
  toSubset,
} from "./openapi.js";
/** API passports (V3-22): ЮKassa, СДЭК, Telegram, amoCRM, Битрикс24, МойСклад — contracts without reading the docs. */
export * from "./passports/index.js";
/** Prose documentation → contract: one T0 research call with code checks of hosts and paths. */
export {
  type ContractDraft,
  contractDraftSchema,
  contractFromDraft,
  contractFromProse,
  draftIssues,
  PROSE_CALL_TYPE,
  type ProseResult,
} from "./prose.js";
/** JSON Schema subset: validateValue (answers), sampleValue (deterministic samples of the mock). */
export {
  API_SCHEMA_TYPES,
  type ApiSchema,
  apiSchemaSchema,
  SCHEMA_LIMITS,
  type SchemaIssue,
  sampleValue,
  validateValue,
} from "./schema.js";
