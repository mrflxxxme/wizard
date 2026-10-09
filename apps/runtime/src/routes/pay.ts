// POST /api/pay/:integration {binding, id, token?} → {confirmationUrl} (connectors/yookassa.yaml#runtime_endpoint): the
// record is read with the caller's rights (V3-23: or by the buyer's secret of the binding's accessField); the amount never
// comes from the request. With connectors: 'live' the payment is created in the client's YooKassa shop, otherwise
// (draft) the mock page /_wizard/pay-mock is used.
import type { Integration } from "@wizard/appspec";
import { startPayment, type YookassaConfig, yookassaAccessMatches } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { type Subject, SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { subjectOf } from "../http/subject.js";
import type { ConnectorHost } from "../preview/connectors.js";
import { connectorFailure, jsonError, readObjectBody } from "../preview/http.js";

/** The yookassa integration (optionally by name) that declares `binding`, with the binding's entity. */
export function yookassaBinding(
  c: RuntimeContext,
  host: ConnectorHost,
  binding: string,
  integration?: string,
): { integ: Integration; entity: string } | null {
  const sys = c.get("system");
  for (const integ of host.integrations(sys.spec, "yookassa")) {
    if (integration !== undefined && integ.name !== integration) continue;
    const b = (integ.config as Partial<YookassaConfig> | undefined)?.bindings?.find((x) => x.id === binding);
    if (b) return { integ, entity: b.entity };
  }
  return null;
}

/** The record as the caller may read it (rights and rowFilter); null when hidden or missing. */
export async function recordFor(c: RuntimeContext, subject: Subject, entity: string, id: string) {
  try {
    return (await c.get("system").data.get(subject, entity, id)) as Record<string, unknown> & { id: string };
  } catch (e) {
    if (e instanceof WizardError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) return null;
    throw e;
  }
}

/** The buyer's secret of a request body or query (`token`, ≤ 128 characters); "" when absent. */
export const tokenOf = (v: unknown): string => (typeof v === "string" && v.length <= 128 ? v : "");

/**
 * The record a payment may start for: as the caller reads it, else (V3-23, an order of a visitor without login) the
 * record whose binding accessField holds the buyer's secret `token` — read as the system, compared in constant time.
 * The record itself never goes back to the caller: only the payment's confirmation URL does.
 */
export async function payableRecord(
  c: RuntimeContext,
  b: { integ: Integration; entity: string },
  binding: string,
  id: string,
  token: string,
): Promise<(Record<string, unknown> & { id: string }) | null> {
  const own = await recordFor(c, await subjectOf(c), b.entity, id);
  if (own || !token) return own;
  const sys = await recordFor(c, SYSTEM_SUBJECT, b.entity, id);
  return sys && yookassaAccessMatches(b.integ.config as YookassaConfig, binding, sys, token) ? sys : null;
}

/** The draft mock page of a payment started by the buyer's secret carries it (the page reads the order by it). */
export const withToken = (url: string, token: string): string =>
  token && url.startsWith("/_wizard/pay-mock?") ? `${url}&t=${encodeURIComponent(token)}` : url;

/** Origin of the current system host (return_url of the payment, webhook URL). */
export const requestOrigin = (c: RuntimeContext) =>
  `${c.get("services").env.publicScheme}://${c.get("host")}`;

export function payRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.post("/:integration", async (c) => {
    const body = await readObjectBody(c);
    const binding = typeof body.binding === "string" ? body.binding : "";
    const id = typeof body.id === "string" ? body.id : "";
    const b = yookassaBinding(c, host, binding, c.req.param("integration"));
    if (!b) throw new WizardError("NOT_FOUND", { message: "Оплата не настроена" });
    const token = tokenOf(body.token);
    const record = await payableRecord(c, b, binding, id, token);
    try {
      const out = await startPayment(
        host.ctx(c.get("system"), b.integ, requestOrigin(c)),
        { binding, id },
        record,
      );
      if (!out.ok) return jsonError(c, out.status, out.code, out.message_ru);
      return c.json({ confirmationUrl: withToken(out.confirmationUrl, token) }, 200, {
        "Cache-Control": "no-store",
      });
    } catch (e) {
      return connectorFailure(c, e);
    }
  });
  return app;
}
