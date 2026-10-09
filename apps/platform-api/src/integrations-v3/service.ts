// Integrations harness of the platform (V3-20; D77_v3 (15), D37): contracts of the brief's outgoing integrations
// (documentation or an OpenAPI document → contract by code, mock contract tests, a version in
// platform.system_integration_contracts, contractRef and secretRef in a new brief version), the key check that
// switches an integration from the mock to the live API (onIntegrationKey — the hook of the key window V3-21), the
// build hook over the stored contracts, and the keys of the system's own API (role + scopes, sha256 only, shown once).
import {
  type ContractTestReport,
  checkContractKey,
  contractFromDocs,
  contractFromOpenApi,
  contractHash,
  contractRef,
  defaultSecretRef,
  type IntegrationContract,
  integrationsHook,
  type KeyCheckResult,
  mapFields,
  mockTransport,
  OpenApiImportError,
  runContractTests,
} from "@wizard/agents/integrations";
import { createResearch, type ResearchOptions } from "@wizard/agents/research";
import type { AppSpec, SystemBrief } from "@wizard/appspec";
import { staticSecretReader } from "@wizard/connectors";
import { API_KEY_RATE_DEFAULT, type ApiScope, newApiKey, scopeIssues, systemOpenApi } from "@wizard/runtime";
import type postgres from "postgres";
import { BriefConflictError, getLatestBrief, saveBriefVersion } from "../briefs/store.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { systemOrigin } from "../publish/prod.js";
import type { SecretStore } from "../secrets/store.js";
import {
  type ApiKeyRow,
  type ContractRow,
  insertApiKey,
  insertContract,
  latestContract,
  latestContracts,
  setContractCheck,
} from "./store.js";
import { contractTransport, type KeyCheckNet, keyCheckTransport } from "./transport.js";

export interface IntegrationsDeps {
  db: Db;
  pg: postgres.Sql;
  config: Pick<Config, "runtimePort" | "systemsDomain" | "publicScheme">;
  secrets: Pick<SecretStore, "get">;
  /** Research of documentation links (default: createResearch over process.env — fixture mode without the live flag). */
  research?: ResearchOptions;
  /** Network of the key check (tests: a local TLS upstream). */
  keyCheck?: KeyCheckNet;
}

export interface ContractInput {
  /** OpenAPI 3.x / Swagger 2.0 document (JSON text or object). */
  openapi?: unknown;
  /** Documentation link (discover_docs → openapi.json) or the document's own URL. */
  url?: string;
  /** The client's need in words; default — the integration's name in the brief. */
  need?: string;
  /** Exact operations (operationId or «METHOD /path»). */
  operations?: string[];
}

export interface SavedContract {
  row: ContractRow;
  contractRef: string;
  /** false — the same contract as the latest version: nothing was written. */
  changed: boolean;
  /** The key check right after saving when the key was already there. */
  check: IntegrationCheck | null;
}

const dataOf = (brief: SystemBrief) =>
  brief.data.map((d) => ({ entity: d.entity, fields: d.fields.map((f) => ({ name: f.name })) }));

async function briefIntegration(db: Db, systemId: string, integrationId: string) {
  const latest = await getLatestBrief(db, systemId);
  const integ = latest?.brief.integrations.find((i) => i.id === integrationId);
  if (!latest || !integ) throw notFound("Интеграция в брифе");
  return { latest, integ };
}

/** Documentation or a document → validated contract with the field mapping of the brief's data (no model). */
export async function buildContract(
  deps: IntegrationsDeps,
  systemId: string,
  integrationId: string,
  input: ContractInput,
): Promise<IntegrationContract> {
  const { latest, integ } = await briefIntegration(deps.db, systemId, integrationId);
  if (integ.direction !== "out")
    throw invalid("Это входящая интеграция: для неё выпускают ключ API системы, контракт не нужен");
  const base = {
    id: integ.id,
    name: integ.name,
    need: input.need ?? integ.name,
    secret: integ.secretRef ?? defaultSecretRef(integ.id),
    ...(input.operations?.length ? { operations: input.operations } : {}),
  };
  let contract: IntegrationContract;
  if (input.openapi !== undefined) {
    try {
      contract = contractFromOpenApi(input.openapi as string | Record<string, unknown>, {
        ...base,
        url: input.url ?? null,
      });
    } catch (e) {
      if (e instanceof OpenApiImportError) throw invalid(e.message_ru, { reason: e.code });
      throw invalid("Описание API не прочиталось — нужен OpenAPI 3 или Swagger 2 в формате JSON");
    }
  } else if (input.url) {
    const research = createResearch({ ...(deps.research ?? {}), context: { systemId } });
    let r: Awaited<ReturnType<typeof contractFromDocs>>;
    try {
      r = await contractFromDocs({ research, ...base, url: input.url, data: dataOf(latest.brief) });
    } catch (e) {
      throw invalid("Документация по ссылке не открылась", {
        reason: (e as { code?: string }).code ?? "NETWORK",
      });
    }
    if (!r.contract)
      throw invalid(r.reason_ru ?? "Контракт по документации не составлен", { reason: "NO_SPEC" });
    contract = r.contract;
  } else throw invalid("Нужна ссылка на документацию (url) или описание API (openapi)");
  return contract.mapping.length
    ? contract
    : { ...contract, mapping: mapFields(contract, dataOf(latest.brief)) };
}

/**
 * Saves a contract version (mock tests stored with it), writes contractRef and secretRef into a new brief version and,
 * when the key is already entered, runs the key check at once.
 */
export async function saveContract(
  deps: IntegrationsDeps,
  p: { systemId: string; contract: IntegrationContract; userId: string | null; runId?: string | null },
): Promise<SavedContract> {
  const sha = contractHash(p.contract);
  const tests: ContractTestReport = await runContractTests(p.contract, mockTransport(p.contract));
  const prev = await latestContract(deps.pg, p.systemId, p.contract.id);
  let row: ContractRow;
  let changed = true;
  if (prev && prev.sha256 === sha) {
    row = prev;
    changed = false;
  } else
    row = await deps.pg.begin((tx) =>
      insertContract(tx, {
        systemId: p.systemId,
        contract: p.contract,
        sha256: sha,
        tests,
        createdBy: p.userId,
        runId: p.runId ?? null,
      }),
    );
  const ref = contractRef(p.contract.id, row.version, sha);
  const latest = await getLatestBrief(deps.db, p.systemId);
  if (latest) {
    const brief = {
      ...latest.brief,
      integrations: latest.brief.integrations.map((i) =>
        i.id === p.contract.id
          ? {
              ...i,
              contractRef: ref,
              ...(p.contract.auth.secret ? { secretRef: p.contract.auth.secret } : {}),
            }
          : i,
      ),
    };
    try {
      await saveBriefVersion(deps.db, {
        systemId: p.systemId,
        brief,
        author: "agent",
        runId: p.runId ?? null,
        baseVersion: latest.version,
      });
    } catch (e) {
      // The owner edited the brief meanwhile: the contract version stays, the reference is written on the next save.
      if (!(e instanceof BriefConflictError)) throw e;
      throw new ApiError("VERSION_CONFLICT", "Бриф изменился — повторите сохранение контракта", {
        version: e.latest,
      });
    }
  }
  const check =
    changed && (await keyPresent(deps, p.systemId, p.contract))
      ? await checkIntegration(deps, p.systemId, p.contract.id)
      : null;
  const fresh = check ? ((await latestContract(deps.pg, p.systemId, p.contract.id)) ?? row) : row;
  return { row: fresh, contractRef: ref, changed, check };
}

/** Env whose key the check uses: draft when set there, else prod; null — no key anywhere. */
function keyEnv(
  deps: IntegrationsDeps,
  systemId: string,
  name: string,
  env?: "draft" | "prod",
): "draft" | "prod" | null {
  const order: ("draft" | "prod")[] = env ? [env] : ["draft", "prod"];
  return order.find((e) => deps.secrets.get(systemId, e, name) !== null) ?? null;
}

async function keyPresent(
  deps: IntegrationsDeps,
  systemId: string,
  c: IntegrationContract,
): Promise<boolean> {
  return c.auth.secret === null || keyEnv(deps, systemId, c.auth.secret.slice("secret://".length)) !== null;
}

async function systemKeyOf(
  pg: postgres.Sql,
  systemId: string,
): Promise<{ schemaKey: string; slug: string } | null> {
  const [r] =
    await pg`select schema_key, slug from platform.systems where id = ${systemId} and deleted_at is null`;
  return r ? { schemaKey: r.schema_key as string, slug: r.slug as string } : null;
}

/** Result of a key check: the integration's state after it, the contract version, the check itself. */
export interface IntegrationCheck {
  /** mock — no key yet; live — switched on; failed — the key or the contract did not pass. */
  state: ContractRow["status"];
  version: number;
  check: KeyCheckResult;
}

/**
 * The key check of an integration (D77 (15)): the key present → the contract's safe GET through the egress client →
 * live (the next build generates the live client with egress = the contract's hosts) or failed; no key → mock stays.
 */
export async function checkIntegration(
  deps: IntegrationsDeps,
  systemId: string,
  integrationId: string,
  env?: "draft" | "prod",
): Promise<IntegrationCheck> {
  const row = await latestContract(deps.pg, systemId, integrationId);
  if (!row) throw notFound("Контракт интеграции");
  const c = row.contract;
  const name = c.auth.secret?.slice("secret://".length) ?? null;
  const useEnv = name ? keyEnv(deps, systemId, name, env) : (env ?? "draft");
  if (name && !useEnv) {
    const result: KeyCheckResult = {
      ok: false,
      verified: false,
      code: "SECRET_MISSING",
      status: null,
      message_ru: `Ключ «${name}» ещё не введён — интеграция «${c.name}» работает на моке`,
      problems: [],
    };
    return { state: row.status, version: row.version, check: result };
  }
  const sys = await systemKeyOf(deps.pg, systemId);
  if (!sys) throw notFound("Система");
  const e = useEnv ?? "draft";
  const transport =
    deps.keyCheck?.transport !== undefined
      ? deps.keyCheck.transport
      : keyCheckTransport(process.env, { systemKey: sys.schemaKey, env: e }, c.hosts);
  let result: KeyCheckResult;
  if (!transport)
    result = {
      ok: false,
      verified: false,
      code: "UPSTREAM_UNAVAILABLE",
      status: null,
      message_ru: "Проверка ключа сейчас недоступна: у платформы нет выхода к API — попробуйте позже",
      problems: [],
    };
  else {
    const value = name ? deps.secrets.get(systemId, e, name) : null;
    const secrets = staticSecretReader(name && value ? { [name]: value } : {});
    result = await checkContractKey(
      c,
      contractTransport({
        contract: c,
        secrets,
        transport,
        ...(deps.keyCheck?.platformDomains ? { platformDomains: deps.keyCheck.platformDomains } : {}),
      }),
    );
  }
  const status = result.ok ? "live" : "failed";
  await setContractCheck(deps.pg, { systemId, integrationId, version: row.version, status, check: result });
  return { state: status, version: row.version, check: result };
}

/**
 * Hook of the key window (V3-21): a key secret://<name> was entered or rotated for the system — every integration whose
 * latest contract uses it is checked and switched on (or marked failed). Returns the results by integration.
 */
export async function onIntegrationKey(
  deps: IntegrationsDeps,
  p: { systemId: string; secretName: string; env?: "draft" | "prod" },
): Promise<{ integrationId: string; ok: boolean; status: ContractRow["status"]; message_ru: string }[]> {
  const out: { integrationId: string; ok: boolean; status: ContractRow["status"]; message_ru: string }[] = [];
  for (const row of await latestContracts(deps.pg, p.systemId)) {
    if (row.contract.auth.secret !== `secret://${p.secretName}`) continue;
    const r = await checkIntegration(deps, p.systemId, row.integrationId, p.env);
    out.push({
      integrationId: row.integrationId,
      ok: r.check.ok,
      status: r.state,
      message_ru: r.check.message_ru,
    });
  }
  return out;
}

/** V3Host.integrations of a system's build (builds-v3/host.ts: `integrations: integrationsBuildHook(pg, systemId)`). */
export function integrationsBuildHook(pg: postgres.Sql, systemId: string) {
  return integrationsHook(async () =>
    (await latestContracts(pg, systemId)).map((r) => ({
      contract: r.contract,
      version: r.version,
      sha256: r.sha256,
      mode: r.status === "live" ? ("live" as const) : ("mock" as const),
    })),
  );
}

// ------------------------------------------------------------------------------------------------ API keys

/** The spec of an env: the draft revision, or the published one; null — nothing there yet. */
export async function envSpec(
  pg: postgres.Sql,
  systemId: string,
  env: "draft" | "prod",
): Promise<AppSpec | null> {
  const [r] = await pg`
    select r.spec from platform.systems s
      join platform.revisions r
        on r.system_id = s.id and r.version = (case when ${env} = 'prod' then s.prod_revision else s.draft_revision end)
     where s.id = ${systemId} and s.deleted_at is null`;
  if (!r) return null;
  return (typeof r.spec === "string" ? JSON.parse(r.spec) : r.spec) as AppSpec;
}

export interface NewApiKey {
  name: string;
  env: "draft" | "prod";
  role: string;
  scopes: ApiScope[];
  ratePerMinute?: number;
}

/** Issues a key for the system's own API; the key text is in the result only (sha256 stored). */
export async function createApiKey(
  deps: Pick<IntegrationsDeps, "pg">,
  p: { systemId: string; userId: string | null; input: NewApiKey },
): Promise<{ key: string; item: ApiKeyRow }> {
  const spec = await envSpec(deps.pg, p.systemId, p.input.env);
  if (!spec)
    throw invalid(
      p.input.env === "prod"
        ? "Система ещё не опубликована — ключ для неё выпустить нельзя"
        : "У системы ещё нет черновика",
    );
  const issues = scopeIssues(spec, p.input.role, p.input.scopes);
  if (issues.length) throw invalid(issues[0] as string, { issues });
  const k = newApiKey();
  const item = await insertApiKey(deps.pg, {
    systemId: p.systemId,
    env: p.input.env,
    name: p.input.name,
    role: p.input.role,
    scopes: p.input.scopes,
    prefix: k.prefix,
    hash: k.hash,
    ratePerMinute: p.input.ratePerMinute ?? API_KEY_RATE_DEFAULT,
    createdBy: p.userId,
  });
  return { key: k.key, item };
}

/** OpenAPI 3.1 of what a key can do, on the system host of its env. */
export async function keyOpenApi(
  deps: Pick<IntegrationsDeps, "pg" | "config">,
  systemId: string,
  key: ApiKeyRow,
): Promise<Record<string, unknown>> {
  const spec = await envSpec(deps.pg, systemId, key.env);
  const sys = await systemKeyOf(deps.pg, systemId);
  if (!spec || !sys) throw new ApiError("NOT_FOUND", "Ревизия системы не найдена");
  return systemOpenApi(spec, {
    serverUrl: `${systemOrigin(deps.config, sys.slug, key.env)}/api/v1`,
    role: key.role,
    scopes: key.scopes,
  });
}
