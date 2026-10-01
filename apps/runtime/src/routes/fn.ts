// POST /api/fn/:name (runtime.yaml#functions) over DataAccess.runner() + createFunctionHost; handlers run in the
// isolated executor (src/exec). Without WIZARD_UNSAFE_LOCAL_EXEC=1 → 503 FUNCTIONS_DISABLED (isolation.yaml#M0_M1).
import { randomUUID } from "node:crypto";
import { quoteIdent } from "@wizard/appspec";
import { type CurrentUser, WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { consentMatches } from "../compliance.js";
import { type Subject, SYSTEM_SUBJECT } from "../data/access.js";
import { systemFunctions } from "../exec/host.js";
import type { RuntimeHonoEnv } from "../http/context.js";
import { subjectOf } from "../http/subject.js";
import type { LoadedSystem } from "../system.js";
import { readJsonBody } from "./data.js";

/** users fields hidden from ctx.user.attrs: contacts and system columns (sdk.md §2.5). */
const NOT_ATTRS = new Set(["id", "role", "phone", "email", "created_at", "updated_at", "created_by"]);

export function currentUser(s: Subject): CurrentUser {
  const attrs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(s.record)) {
    if (NOT_ATTRS.has(k) || k.startsWith("telegram")) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") attrs[k] = v;
  }
  return { id: s.id, role: s.role, isAdmin: s.isAdmin, attrs } as CurrentUser;
}

/**
 * _w_consents row of a collectsPii call (security/compliance.yaml#system_package.consent.runtime): entity
 * `fn:<name>`, row_id — the caller (users.id) or a random id for the public role.
 */
async function journalFnConsent(
  sys: LoadedSystem,
  name: string,
  userId: string | null,
  ipHmac: Buffer | null,
) {
  await sys.data.transaction("default", SYSTEM_SUBJECT, (d) =>
    d.sql.unsafe(
      `insert into ${quoteIdent(sys.schema)}."_w_consents" (entity, row_id, policy_version, consent_text_hash, ip_hmac)
       values ($1, $2::uuid, $3, decode($4, 'hex'), $5)`,
      [
        `fn:${name}`,
        userId ?? randomUUID(),
        sys.compliance.policyVersion,
        sys.compliance.consentTextHash,
        ipHmac,
      ] as never[],
    ),
  );
}

export function fnRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.use("*", async (c, next) => {
    const svc = c.get("services");
    if (!svc.env.unsafeLocalExec && !svc.sandbox) throw new WizardError("FUNCTIONS_DISABLED");
    await next();
  });
  app.post("/:name", async (c) => {
    const body = await readJsonBody(c);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new WizardError("VALIDATION_FAILED", { message: "Ожидается объект {args}" });
    }
    const { args, _consent } = body as { args?: unknown; _consent?: unknown };
    const sys = c.get("system");
    const services = c.get("services");
    const user = currentUser(await subjectOf(c));
    const { host } = await systemFunctions(sys, services, services.log);
    // createFunctionHost checks presence; the content must match the current consent text and policy.
    const consent = consentMatches(sys.compliance, _consent)
      ? (_consent as { policyVersion: string; textHash: string })
      : undefined;
    const name = c.req.param("name");
    const r = await host.call(name, args ?? {}, { user, via: "api", consent });
    const fn = sys.spec.functions?.find((f) => f.name === name);
    if (fn?.collectsPii === true && !user.isAdmin && consent)
      await journalFnConsent(sys, name, user.id, services.ipHmac?.(c.req.raw) ?? null);
    return c.json({ result: r.result, deps: r.deps });
  });
  return app;
}
