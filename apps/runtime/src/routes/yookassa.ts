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
  yookassaWebhookUrl,
} from "@wizard/connectors";
import { Hono } from "hono";
import { clientIpOf } from "../auth/client-ip.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { sessionOf } from "../http/subject.js";
import type { ConnectorHost } from "../preview/connectors.js";
import { documentHeaders, escapeHtml, htmlPage } from "../preview/headers.js";
import { requestOrigin } from "./pay.js";

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

/** Route of the owner's page with the ЮKassa notification address (yookassa.yaml#webhooks.path). */
export const PAYMENTS_SETTINGS_PAGE = "/_wizard/payments";

/**
 * GET /_wizard/payments (isAdmin roles): the HTTP-notification URL of each ЮKassa integration — the owner pastes it
 * into the ЮKassa dashboard (Интеграция → HTTP-уведомления). The token is derived from the shop's secret key, which
 * only the runtime holds, so the address is shown here and not in the platform's cabinet.
 */
export function yookassaSettingsRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.get("/", async (c) => {
    const title = "Уведомления ЮKassa";
    const s = await sessionOf(c).catch(() => null);
    if (s?.subject.id == null) {
      const body = `<p><a href="/login?next=${encodeURIComponent(PAYMENTS_SETTINGS_PAGE)}">Войдите</a> как владелец системы.</p>`;
      return c.body(htmlPage(title, body), 200, documentHeaders("no-store"));
    }
    if (!s.subject.isAdmin) {
      const body = "<p>Нет доступа: страница доступна только владельцу системы.</p>";
      return c.body(htmlPage(title, body), 403, documentHeaders("no-store"));
    }
    const sys = c.get("system");
    const items: string[] = [];
    for (const integ of host.integrations(sys.spec, "yookassa")) {
      let line: string;
      if (!yookassaPlatform(host).live) {
        line = "Приём уведомлений включится в опубликованной системе с подключёнными ключами ЮKassa.";
      } else {
        try {
          const url = await yookassaWebhookUrl(host.ctx(sys, integ, requestOrigin(c)));
          line = `<code data-testid="wz-yookassa-webhook-url">${escapeHtml(url)}</code>`;
        } catch (e) {
          if (!isConnectorError(e)) throw e;
          line =
            "Сначала подключите ключи ЮKassa (shopId и секретный ключ) — адрес строится из секретного ключа.";
        }
      }
      items.push(`<li>${line}</li>`);
    }
    const body = items.length
      ? `<p>Скопируйте адрес и вставьте его в личном кабинете ЮKassa: «Интеграция» → «HTTP-уведомления», отметьте события payment.succeeded, payment.canceled, payment.waiting_for_capture и refund.succeeded. Без него заказ отмечается оплаченным, только когда покупатель вернулся на сайт после оплаты.</p><ul>${items.join("")}</ul><p>Адрес секретный: не публикуйте его.</p>`
      : "<p>В системе нет приёма оплаты через ЮKassa.</p>";
    return c.body(htmlPage(title, body), 200, documentHeaders("no-store"));
  });
  app.all("*", () => notFoundPage());
  return app;
}
