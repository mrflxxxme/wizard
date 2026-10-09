// /systems/:id/secrets* and /systems/:id/secret-windows* (V3-21; api.yaml): the keys of a system (hosts, last 4
// characters, version, check — never a value), the key window (open for an integration, read with its public key,
// submit the ciphertext made in the browser, cancel), the re-check and the removal of a key. The list needs viewer,
// everything else editor; another org's system is 404. Answers carry Cache-Control: no-store.
import { Hono } from "hono";
import { z } from "zod";
import { notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody, parseQuery } from "../http/util.js";
import { SEALED_MAX_CT, WINDOW_ALG } from "./crypto.js";
import {
  cancelWindow,
  checkSecret,
  listSecrets,
  openConnectorWindow,
  openIntegrationWindow,
  removeSecret,
  SECRET_WINDOW_NAME,
  type SecretWindowDeps,
  submitWindow,
  windowWithKey,
} from "./service.js";

const envSchema = z.enum(["draft", "prod"]);
const openBody = z.union([
  z.strictObject({
    integrationId: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    env: envSchema.optional(),
  }),
  // V3-23: a key of a module's connector (the shop's ЮKassa) by its name.
  z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    env: envSchema.optional(),
  }),
]);
const b64url = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);
const sealedBody = z.strictObject({
  v: z.literal(1),
  alg: z.literal(WINDOW_ALG),
  epk: z.strictObject({ kty: z.literal("EC"), crv: z.literal("P-256"), x: b64url(64), y: b64url(64) }),
  iv: b64url(32),
  ct: b64url(SEALED_MAX_CT),
});
const checkBody = z.strictObject({ env: envSchema.optional() });

export type SecretWindowRoutesDeps = Pick<Deps, "db" | "pg" | "config"> &
  Omit<SecretWindowDeps, "db" | "pg" | "config">;

export function secretWindowRoutes(d: SecretWindowRoutesDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const deps: SecretWindowDeps = d;

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
  const windowId = (raw: string | undefined): string => {
    if (!isUuid(raw)) throw notFound("Окно ключа");
    return raw;
  };
  const secretName = (raw: string | undefined): string => {
    if (!raw || !SECRET_WINDOW_NAME.test(raw)) throw notFound("Ключ");
    return raw;
  };

  r.get("/systems/:id/secrets", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    c.header("Cache-Control", "no-store");
    return c.json(await listSecrets(deps, s.id));
  });

  // The owner opens the window for an integration of the brief (the contract gives the key name and the hosts).
  r.post("/systems/:id/secret-windows", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    const body = await jsonBody(c, openBody);
    const out =
      "name" in body
        ? await openConnectorWindow(deps, {
            systemId: s.id,
            name: body.name,
            userId: user.id,
            ...(body.env ? { env: body.env } : {}),
          })
        : await openIntegrationWindow(deps, {
            systemId: s.id,
            integrationId: body.integrationId,
            userId: user.id,
            ...(body.env ? { env: body.env } : {}),
          });
    c.header("Cache-Control", "no-store");
    return c.json({ window: out.window }, out.created ? 201 : 200);
  });

  // An open window with its public key (made and sealed on the first read).
  r.get("/systems/:id/secret-windows/:windowId", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const w = await windowWithKey(deps, s.id, windowId(c.req.param("windowId")));
    c.header("Cache-Control", "no-store");
    return c.json({ window: w });
  });

  // The ciphertext of the key made in the browser: opened only inside the secret store, checked, stored.
  r.post("/systems/:id/secret-windows/:windowId/submit", async (c) => {
    const user = c.get("user");
    const s = await loadSystem(user, c.req.param("id"), "editor");
    const id = windowId(c.req.param("windowId"));
    const sealed = await jsonBody(c, sealedBody);
    const out = await submitWindow(deps, { systemId: s.id, windowId: id, sealed, userId: user.id });
    c.header("Cache-Control", "no-store");
    return c.json(out);
  });

  r.delete("/systems/:id/secret-windows/:windowId", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    return c.json({ window: await cancelWindow(deps, s.id, windowId(c.req.param("windowId"))) });
  });

  r.post("/systems/:id/secrets/:name/check", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const name = secretName(c.req.param("name"));
    const body = await jsonBody(c, checkBody);
    c.header("Cache-Control", "no-store");
    return c.json(await checkSecret(deps, { systemId: s.id, name, env: body.env ?? "draft" }));
  });

  r.delete("/systems/:id/secrets/:name", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "editor");
    const name = secretName(c.req.param("name"));
    const q = parseQuery(c, z.object({ env: envSchema.default("draft") }));
    return c.json(await removeSecret(deps, { systemId: s.id, name, env: q.env }));
  });

  return r;
}
