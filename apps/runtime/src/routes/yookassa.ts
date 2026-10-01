// YooKassa HTTP notifications: POST /_wizard/hooks/yookassa/:integration/:hookToken (connectors/yookassa.yaml#webhooks).
// YooKassa does not sign notifications: the source IP (trusted-ingress hop only) must be in the allowlist, then the
// object is re-read from the API with the shop's keys — the body is never trusted.
import type { Integration } from "@wizard/appspec";
import {
  handleYookassaNotification,
  isConnectorError,
  secretMatches,
  yookassaHookToken,
  yookassaPlatform,
  yookassaSourceAllowed,
} from "@wizard/connectors";
import { Hono } from "hono";
import { clientIpOf } from "../auth/client-ip.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import type { ConnectorHost } from "../preview/connectors.js";

/** connector-interface.md §2 «Вебхуки»: body ≤ 256 KiB. */
export const YOOKASSA_HOOK_BODY_MAX = 256 * 1024;

function yookassaIntegration(c: RuntimeContext, host: ConnectorHost, name: string): Integration | null {
  return host.integrations(c.get("system").spec, "yookassa").find((i) => i.name === name) ?? null;
}

const status = (code: number) => Response.json(code === 200 ? {} : { ok: false }, { status: code });

async function readBody(req: Request): Promise<{ tooLarge: boolean; body: unknown }> {
  if (Number(req.headers.get("content-length") ?? "0") > YOOKASSA_HOOK_BODY_MAX)
    return { tooLarge: true, body: null };
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > YOOKASSA_HOOK_BODY_MAX) return { tooLarge: true, body: null };
  try {
    return { tooLarge: false, body: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { tooLarge: false, body: null };
  }
}

export function yookassaHookRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.post("/:integration/:hookToken", async (c) => {
    const integ = yookassaIntegration(c, host, c.req.param("integration"));
    // Without API access there is nothing to verify against: the hook does not exist.
    if (!integ || !yookassaPlatform(host).live) return notFoundPage();
    // (1) Source address before anything else is read; X-Forwarded-For counts only from a trusted ingress.
    if (!yookassaSourceAllowed(host, clientIpOf(c.req.raw))) return status(401);
    const ctx = host.ctx(c.get("system"), integ);
    let expected: string;
    try {
      expected = await yookassaHookToken(ctx);
    } catch (e) {
      if (isConnectorError(e)) return notFoundPage();
      throw e;
    }
    if (!secretMatches(c.req.param("hookToken"), expected)) return notFoundPage();
    const { tooLarge, body } = await readBody(c.req.raw);
    if (tooLarge) return new Response(null, { status: 413 });
    try {
      // (2) Decision only by the API answer (GET /payments/{id}, /refunds/{id}).
      return status((await handleYookassaNotification(ctx, body)).status);
    } catch (e) {
      // Unknown outcome: 500 makes YooKassa redeliver for up to 24 h.
      c.get("services").log?.({
        ts: new Date().toISOString(),
        level: "error",
        requestId: c.get("requestId"),
        msg: "yookassa_hook_failed",
        system: c.get("system").entry.slug,
        integration: integ.name,
        errorCode: isConnectorError(e) ? e.code : "INTERNAL",
      });
      return status(500);
    }
  });
  app.all("*", () => notFoundPage());
  return app;
}
