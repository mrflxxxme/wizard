// /api/v1/* of a system host — the system's own API for the client's external systems (V3-20; runtime.yaml#incoming_api,
// D77_v3 (15)): Authorization: Bearer wzk_… only (cookies are ignored, so CSRF does not apply), the key of this
// system and env, its scopes first, then the data API of its role — permissions, hidden and read-only fields,
// rowFilter and RLS exactly as for a person of that role (DataAccess). Requests per minute per key, failed key
// attempts per client address, an audit row per request (method, target, status, time — no values).
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { clientIpOf } from "../auth/client-ip.js";
import { consentMatches } from "../compliance.js";
import type { Subject } from "../data/access.js";
import { systemFunctions } from "../exec/host.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { errorResponse } from "../http/errors.js";
import { parseListQuery, readJsonBody } from "../routes/data.js";
import { currentUser } from "../routes/fn.js";
import { MinuteWindows } from "../sandbox/egress-fetch.js";
import { API_KEY_RE, type ApiKeyRecord, type ApiKeyStore, hashApiKey } from "./keys.js";
import { systemOpenApi } from "./openapi.js";
import { type ApiDataOp, scopeAllows, scopeAllowsFn } from "./scopes.js";

/** Prefix of the incoming API on a system host. */
export const INCOMING_API_PREFIX = "/api/v1";
/** Failed key attempts per client address per minute before 429. */
export const API_AUTH_FAILURES_PER_MINUTE = 20;

/** The path belongs to the key-authenticated API (no cookies → exempt from CSRF and the draft session gate). */
export function isIncomingApiPath(path: string): boolean {
  return path === INCOMING_API_PREFIX || path.startsWith(`${INCOMING_API_PREFIX}/`);
}

export interface IncomingApiOptions {
  /** Keys of the platform (pgApiKeyStore) or memory; null — the API answers 404. */
  store: ApiKeyStore | null;
  clock?: () => number;
}

interface KeyContext {
  key: ApiKeyRecord;
  subject: Subject;
}

const unauthenticated = () =>
  new WizardError("UNAUTHENTICATED", { message: "Нужен ключ API: заголовок Authorization: Bearer wzk_…" });

export function incomingApiRoutes(o: IncomingApiOptions): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  const clock = o.clock ?? Date.now;
  const perKey = new MinuteWindows(clock);
  const failures = new MinuteWindows(clock);
  const keys = new WeakMap<Request, KeyContext>();

  const keyOf = (c: RuntimeContext): KeyContext => {
    const k = keys.get(c.req.raw);
    if (!k) throw unauthenticated();
    return k;
  };
  const target = (c: RuntimeContext): string => {
    const m = /^\/api\/v1\/(data|fn)\/([A-Za-z0-9_]+)(\/[^/]+)?$/.exec(new URL(c.req.url).pathname);
    if (!m) return new URL(c.req.url).pathname.endsWith("/openapi.json") ? "openapi" : "other";
    return `${m[1]}:${m[2]}${m[3] ? "/:id" : ""}`;
  };

  app.use("*", async (c, next) => {
    if (!o.store) throw new WizardError("NOT_FOUND", { message: "API системы не подключён" });
    const store = o.store;
    // Error answers with their own headers (WWW-Authenticate, Retry-After) are returned, not thrown.
    const answer = (err: WizardError, headers: Record<string, string>) => {
      const res = errorResponse(err, c.get("requestId"));
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    };
    const ip = clientIpOf(c.req.raw);
    const fail = () =>
      ip && !failures.take(ip, API_AUTH_FAILURES_PER_MINUTE)
        ? answer(new WizardError("RATE_LIMITED"), { "Retry-After": "60" })
        : answer(unauthenticated(), { "WWW-Authenticate": 'Bearer realm="system-api"' });
    const m = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
    if (!m || !API_KEY_RE.test(m[1] as string)) return fail();
    const sys = c.get("system");
    const key = await store.find(hashApiKey(m[1] as string));
    // A key of another system or env is the same as no key: nothing tells which systems exist.
    if (!key || key.systemKey !== sys.entry.systemId || key.env !== sys.entry.env) return fail();
    const started = clock();
    const journal = (status: number) =>
      store
        .used(key, { method: c.req.method, target: target(c), status, durationMs: clock() - started })
        .catch(() => {});
    if (!perKey.take(key.id, key.ratePerMinute)) {
      await journal(429);
      return answer(new WizardError("RATE_LIMITED"), {
        "Retry-After": String(60 - Math.floor((clock() % 60_000) / 1000)),
      });
    }
    const role = sys.spec.roles.find((r) => r.name === key.role);
    if (!role) {
      await journal(403);
      throw new WizardError("FORBIDDEN", {
        message: "Роли этого ключа больше нет в системе — выпустите новый ключ",
      });
    }
    keys.set(c.req.raw, {
      key,
      subject: { id: null, role: role.name, isAdmin: role.isAdmin === true, record: {} },
    });
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } catch (e) {
      status = errorResponse(e, "").status;
      throw e;
    } finally {
      await journal(status);
    }
  });

  const allow = (c: RuntimeContext, entity: string, op: ApiDataOp): Subject => {
    const k = keyOf(c);
    if (!scopeAllows(k.key.scopes, entity, op))
      throw new WizardError("FORBIDDEN", { message: "Ключ не даёт доступа к этому действию" });
    return k.subject;
  };
  const data = (c: RuntimeContext) => c.get("system").data;

  app.get("/openapi.json", (c) => {
    const k = keyOf(c);
    const sys = c.get("system");
    const scheme = c.get("services").env.publicScheme;
    return c.json(
      systemOpenApi(sys.spec, {
        serverUrl: `${scheme}://${c.get("host")}${INCOMING_API_PREFIX}`,
        role: k.key.role,
        scopes: k.key.scopes,
        version: sys.entry.specHash || String(sys.entry.revision),
      }),
    );
  });
  app.get("/data/:entity", async (c) => {
    const entity = c.req.param("entity");
    const subject = allow(c, entity, "read");
    return c.json(await data(c).list(subject, entity, parseListQuery(new URL(c.req.url).searchParams)));
  });
  app.post("/data/:entity", async (c) => {
    const entity = c.req.param("entity");
    const subject = allow(c, entity, "create");
    const body = await readJsonBody(c);
    return c.json({ item: await data(c).create(subject, entity, body, { ipHmac: null }) }, 201);
  });
  app.get("/data/:entity/:id", async (c) => {
    const entity = c.req.param("entity");
    const subject = allow(c, entity, "read");
    return c.json({ item: await data(c).get(subject, entity, c.req.param("id")) });
  });
  app.patch("/data/:entity/:id", async (c) => {
    const entity = c.req.param("entity");
    const subject = allow(c, entity, "update");
    const body = await readJsonBody(c);
    return c.json({ item: await data(c).update(subject, entity, c.req.param("id"), body, { ipHmac: null }) });
  });
  app.delete("/data/:entity/:id", async (c) => {
    const entity = c.req.param("entity");
    const subject = allow(c, entity, "delete");
    await data(c).remove(subject, entity, c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/fn/:name", async (c) => {
    const k = keyOf(c);
    const name = c.req.param("name");
    if (!scopeAllowsFn(k.key.scopes, name))
      throw new WizardError("FORBIDDEN", { message: "Ключ не даёт доступа к этой функции" });
    const services = c.get("services");
    if (!services.env.unsafeLocalExec && !services.sandbox) throw new WizardError("FUNCTIONS_DISABLED");
    const body = await readJsonBody(c);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new WizardError("VALIDATION_FAILED", { message: "Ожидается объект {args}" });
    const { args, _consent } = body as { args?: unknown; _consent?: unknown };
    const sys = c.get("system");
    const { host } = await systemFunctions(sys, services, services.log);
    const consent = consentMatches(sys.compliance, _consent)
      ? (_consent as { policyVersion: string; textHash: string })
      : undefined;
    // The host checks function.public and function.roles for the key's role, validates args, runs it isolated.
    const r = await host.call(name, args ?? {}, { user: currentUser(k.subject), via: "api", consent });
    return c.json({ result: r.result, deps: r.deps });
  });
  app.all("*", () => {
    throw new WizardError("NOT_FOUND", { message: "Адрес не найден" });
  });
  return app;
}
