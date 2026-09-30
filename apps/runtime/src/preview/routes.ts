// Draft-only service routes of a system host: /_wizard/bridge.js, /_wizard/wz-map.json, /_wizard/pay-mock
// (platform-screens.yaml#preview_contract, runtime.yaml#service_endpoints) and POST /api/pay/:integration
// (connectors/yookassa.yaml#runtime_endpoint, M0 stub).
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Integration } from "@wizard/appspec";
import { confirmMockPayment, startPayment, type YookassaConfig } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type { Subject } from "../data/access.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { subjectOf } from "../http/subject.js";
import type { ConnectorHost } from "./connectors.js";
import { documentHeaders, escapeHtml, htmlPage, NO_CACHE } from "./headers.js";
import { connectorFailure, jsonError, readObjectBody } from "./http.js";

const BRIDGE_SOURCE = readFileSync(new URL("./bridge-client.js", import.meta.url), "utf8");
const PAY_MOCK_SCRIPT = readFileSync(new URL("./pay-mock-client.js", import.meta.url), "utf8");

const scriptHeaders = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": NO_CACHE };

/** Bridge script with the platform origin (WIZARD_PLATFORM_ORIGIN) and the revision of this host. */
export function bridgeScript(platformOrigin: string, revision: number): string {
  const config = JSON.stringify({ platformOrigin, revision }).replace(/</g, "\\u003c");
  return `${BRIDGE_SOURCE}\nwizardBridge(window, ${config});\n`;
}

const isDraft = (c: RuntimeContext) => c.get("system").entry.env === "draft";

function yookassaBinding(c: RuntimeContext, host: ConnectorHost, binding: string, integration?: string) {
  const sys = c.get("system");
  for (const integ of host.integrations(sys.spec, "yookassa")) {
    if (integration !== undefined && integ.name !== integration) continue;
    const b = (integ.config as Partial<YookassaConfig> | undefined)?.bindings?.find((x) => x.id === binding);
    if (b) return { integ, entity: b.entity };
  }
  return null;
}

/** The record as the caller may read it (rights and rowFilter); null when hidden or missing. */
async function recordFor(c: RuntimeContext, subject: Subject, entity: string, id: string) {
  try {
    return (await c.get("system").data.get(subject, entity, id)) as Record<string, unknown> & { id: string };
  } catch (e) {
    if (e instanceof WizardError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) return null;
    throw e;
  }
}

const money = (v: unknown) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(Number(v ?? 0));

export function previewRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();

  app.get("/bridge.js", (c) => {
    if (!isDraft(c)) return notFoundPage();
    const sys = c.get("system");
    return c.body(bridgeScript(c.get("services").env.platformOrigin, sys.entry.revision), 200, scriptHeaders);
  });

  app.get("/wz-map.json", async (c) => {
    const dir = c.get("system").artifactDir;
    if (!isDraft(c) || !dir) return notFoundPage();
    try {
      const body = await readFile(join(dir, "wz-map.json"));
      return c.body(new Uint8Array(body), 200, {
        "Content-Type": "application/json",
        "Cache-Control": NO_CACHE,
      });
    } catch {
      return notFoundPage();
    }
  });

  app.get("/pay-mock.js", (c) => (isDraft(c) ? c.body(PAY_MOCK_SCRIPT, 200, scriptHeaders) : notFoundPage()));

  app.get("/pay-mock", async (c) => {
    const binding = c.req.query("binding") ?? "";
    const id = c.req.query("id") ?? "";
    const b = isDraft(c) ? yookassaBinding(c, host, binding) : null;
    if (!b) return notFoundPage();
    const bindingCfg = (b.integ.config as YookassaConfig).bindings.find((x) => x.id === binding);
    const record = await recordFor(c, await subjectOf(c), b.entity, id);
    if (!record || !bindingCfg) return notFoundPage();
    const body = [
      "<p>Это тестовая оплата черновика: деньги не списываются.</p>",
      bindingCfg.description ? `<p>${escapeHtml(bindingCfg.description)}</p>` : "",
      `<p data-testid="wz-pay-amount">Сумма: ${escapeHtml(money(record[bindingCfg.amountField]))}</p>`,
      `<button type="button" id="wz-pay-confirm" data-testid="wz-pay-confirm" data-binding="${escapeHtml(binding)}" data-id="${escapeHtml(id)}">Оплатить</button>`,
      '<p id="wz-pay-error" role="alert" hidden>Оплата не прошла. Обновите страницу и попробуйте снова.</p>',
    ].join("");
    return c.body(
      htmlPage("Тестовая оплата", body, ["/_wizard/pay-mock.js"]),
      200,
      documentHeaders("no-store"),
    );
  });

  app.post("/pay-mock", async (c) => {
    const body = await readObjectBody(c);
    const binding = typeof body.binding === "string" ? body.binding : "";
    const id = typeof body.id === "string" ? body.id : "";
    const b = isDraft(c) ? yookassaBinding(c, host, binding) : null;
    const record = b ? await recordFor(c, await subjectOf(c), b.entity, id) : null;
    if (!b || !record) throw new WizardError("NOT_FOUND", { message: "Заказ не найден" });
    try {
      const out = await confirmMockPayment(host.ctx(c.get("system"), b.integ, c.get("host")), {
        binding,
        id,
      });
      if (!out.ok) throw new WizardError("NOT_FOUND", { message: "Нет платежа, ожидающего оплаты" });
      return c.json({ result: out.result, returnUrl: out.returnUrl }, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      return connectorFailure(c, e);
    }
  });

  return app;
}

/** POST /api/pay/:integration {binding, id} → {confirmationUrl} (yookassa.yaml#runtime_endpoint). */
export function payRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.post("/:integration", async (c) => {
    const body = await readObjectBody(c);
    const binding = typeof body.binding === "string" ? body.binding : "";
    const id = typeof body.id === "string" ? body.id : "";
    const b = yookassaBinding(c, host, binding, c.req.param("integration"));
    if (!b) throw new WizardError("NOT_FOUND", { message: "Оплата не настроена" });
    const record = await recordFor(c, await subjectOf(c), b.entity, id);
    try {
      const integ: Integration = b.integ;
      const out = await startPayment(
        host.ctx(c.get("system"), integ, c.get("host")),
        { binding, id },
        record,
      );
      if (!out.ok) return jsonError(c, out.status, out.code, out.message_ru);
      return c.json({ confirmationUrl: out.confirmationUrl }, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      return connectorFailure(c, e);
    }
  });
  return app;
}
