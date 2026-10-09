// /systems/:id/integrations* and /systems/:id/api-keys* (V3-20; api.yaml): the brief's integrations with their
// contracts and states, a contract from documentation or an OpenAPI document, the key check (mock → live), and the
// keys of the system's own API with the OpenAPI of each key and its request journal. Lists need viewer; contract
// details, a key's OpenAPI and journal, and changes need editor; another org's system is 404. Key values appear once — in the answer of the creation.
import { parseScopes } from "@wizard/runtime";
import { Hono } from "hono";
import { z } from "zod";
import { getLatestBrief } from "../briefs/store.js";
import { invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import type { SecretStore } from "../secrets/store.js";
import {
  buildContract,
  checkIntegration,
  createApiKey,
  type IntegrationsDeps,
  keyOpenApi,
  saveContract,
} from "./service.js";
import {
  getApiKey,
  latestContract,
  latestContracts,
  listApiCalls,
  listApiKeys,
  revokeApiKey,
} from "./store.js";

const IDENT = /^[a-z][a-z0-9_]{0,39}$/;
const envSchema = z.enum(["draft", "prod"]);
const contractBody = z.strictObject({
  openapi: z.union([z.string().max(5 * 1024 * 1024), z.record(z.string(), z.unknown())]).optional(),
  url: z.string().url().max(500).optional(),
  need: z.string().trim().min(1).max(500).optional(),
  operations: z.array(z.string().max(300)).max(30).optional(),
});
const checkBody = z.strictObject({ env: envSchema.optional() });
const keyBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  env: envSchema,
  role: z.string().regex(IDENT),
  scopes: z.unknown(),
  ratePerMinute: z.number().int().min(1).max(600).optional(),
});

export type IntegrationRoutesDeps = Pick<Deps, "db" | "pg" | "config"> & {
  secrets: Pick<SecretStore, "get">;
} & Pick<IntegrationsDeps, "research" | "keyCheck">;

export function integrationRoutes(d: IntegrationRoutesDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const deps: IntegrationsDeps = d;

  async function loadSystem(user: AuthUser, id: string | undefined, min: OrgRole): Promise<{ id: string }> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система");
    return s;
  }
  const integrationId = (raw: string | undefined): string => {
    if (!raw || !IDENT.test(raw)) throw notFound("Интеграция");
    return raw;
  };
  const summary = (row: Awaited<ReturnType<typeof latestContract>>) =>
    row && {
      version: row.version,
      sha256: row.sha256,
      status: row.status,
      baseUrl: row.contract.baseUrl,
      hosts: row.contract.hosts,
      auth: row.contract.auth,
      operations: row.contract.operations.map((o) => ({
        id: o.id,
        method: o.method,
        path: o.path,
        summary: o.summary,
      })),
      check: row.contract.check,
      mapping: row.contract.mapping,
      notes: row.contract.notes,
      tests: row.tests,
      keyCheck: row.keyCheck,
      checkedAt: row.checkedAt,
      createdAt: row.createdAt,
    };

  // The brief's integrations: outgoing with their contract and state, incoming with the number of active keys.
  r.get("/systems/:id/integrations", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const brief = await getLatestBrief(d.db, s.id);
    const contracts = new Map((await latestContracts(d.pg, s.id)).map((x) => [x.integrationId, x]));
    const keys = (await listApiKeys(d.pg, s.id)).filter((k) => !k.revokedAt);
    const items = (brief?.brief.integrations ?? []).map((i) => {
      const name = i.secretRef?.slice("secret://".length) ?? `${i.id}_key`;
      return {
        id: i.id,
        name: i.name,
        direction: i.direction,
        contractRef: i.contractRef ?? null,
        secretRef: i.secretRef ?? null,
        contract: summary(contracts.get(i.id) ?? null),
        keyPresent:
          i.direction === "out"
            ? {
                draft: d.secrets.get(s.id, "draft", name) !== null,
                prod: d.secrets.get(s.id, "prod", name) !== null,
              }
            : null,
        apiKeys: i.direction === "in" ? keys.length : null,
      };
    });
    return c.json({ items });
  });

  // Documentation link or OpenAPI document → contract (by code), mock tests, contractRef in the brief.
  r.post("/systems/:id/integrations/:integrationId/contract", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    const id = integrationId(c.req.param("integrationId"));
    const body = await jsonBody(c, contractBody);
    const contract = await buildContract(deps, s.id, id, body);
    const saved = await saveContract(deps, { systemId: s.id, contract, userId: user.id });
    return c.json(
      {
        contractRef: saved.contractRef,
        changed: saved.changed,
        contract: summary(saved.row),
        check: saved.check,
      },
      saved.changed ? 201 : 200,
    );
  });

  r.get("/systems/:id/integrations/:integrationId/contract", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const row = await latestContract(d.pg, s.id, integrationId(c.req.param("integrationId")));
    if (!row) throw notFound("Контракт интеграции");
    return c.json({ contract: row.contract, ...summary(row) });
  });

  // The key check: key present → the contract's safe GET through the egress client → live or failed.
  r.post("/systems/:id/integrations/:integrationId/check", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const id = integrationId(c.req.param("integrationId"));
    const body = await jsonBody(c, checkBody);
    return c.json(await checkIntegration(deps, s.id, id, body.env));
  });

  r.get("/systems/:id/api-keys", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    return c.json({ items: await listApiKeys(d.pg, s.id) });
  });

  r.post("/systems/:id/api-keys", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    const body = await jsonBody(c, keyBody);
    const scopes = parseScopes(body.scopes);
    if (!scopes) throw invalid("scopes: список {entity, ops} или {fn}, не больше 50");
    const created = await createApiKey(d, {
      systemId: s.id,
      userId: user.id,
      input: {
        name: body.name,
        env: body.env,
        role: body.role,
        scopes,
        ...(body.ratePerMinute ? { ratePerMinute: body.ratePerMinute } : {}),
      },
    });
    c.header("Cache-Control", "no-store");
    return c.json(created, 201);
  });

  r.delete("/systems/:id/api-keys/:keyId", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const keyId = c.req.param("keyId");
    if (!isUuid(keyId)) throw notFound("Ключ");
    const item = await revokeApiKey(d.pg, s.id, keyId);
    if (!item) throw notFound("Ключ");
    return c.json({ item });
  });

  r.get("/systems/:id/api-keys/:keyId/openapi.json", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const keyId = c.req.param("keyId");
    const key = isUuid(keyId) ? await getApiKey(d.pg, s.id, keyId) : null;
    if (!key) throw notFound("Ключ");
    return c.json(await keyOpenApi(d, s.id, key));
  });

  r.get("/systems/:id/api-keys/:keyId/calls", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const keyId = c.req.param("keyId");
    if (!isUuid(keyId) || !(await getApiKey(d.pg, s.id, keyId))) throw notFound("Ключ");
    return c.json({ items: await listApiCalls(d.pg, s.id, keyId) });
  });

  return r;
}
