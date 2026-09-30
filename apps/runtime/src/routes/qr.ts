// /_wizard/qr/* (connectors/qr.yaml#endpoints, #checkin_algorithm). CSRF is enforced by app.ts for POST.
import type { Integration } from "@wizard/appspec";
import { qrCheck } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { subjectOf } from "../http/subject.js";
import type { ConnectorHost } from "../preview/connectors.js";
import { connectorFailure, readObjectBody } from "../preview/http.js";

function integrationOf(c: RuntimeContext, host: ConnectorHost): Integration {
  const all = host.integrations(c.get("system").spec, "qr");
  const name = c.req.query("integration");
  if (name !== undefined) {
    const hit = all.find((i) => i.name === name);
    if (hit) return hit;
  } else if (all.length === 1) {
    return all[0] as Integration;
  } else if (all.length > 1) {
    throw new WizardError("VALIDATION_FAILED", {
      message: "Укажите интеграцию QR",
      fields: [{ field: "integration", code: "REQUIRED", message: "Обязательный параметр" }],
    });
  }
  throw new WizardError("NOT_FOUND", { message: "QR-билеты в системе не настроены" });
}

const short = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

export function qrRoutes(host: ConnectorHost): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();

  app.post("/check", async (c) => {
    const integ = integrationOf(c, host);
    const subject = await subjectOf(c);
    const body = await readObjectBody(c);
    const bad: { field: string; code: string; message: string }[] = [];
    if (!short(body.payload, 200))
      bad.push({ field: "payload", code: "INVALID", message: "Нет кода билета" });
    if (!short(body.deviceId, 100))
      bad.push({ field: "deviceId", code: "INVALID", message: "Нет идентификатора устройства" });
    if (body.checkpoint !== undefined && !short(body.checkpoint, 100))
      bad.push({ field: "checkpoint", code: "INVALID", message: "Неверное название входа" });
    if (bad.length > 0) throw new WizardError("VALIDATION_FAILED", { fields: bad });
    const sys = c.get("system");
    try {
      const out = await qrCheck(host.ctx(sys, integ, c.get("host")), subject.role, {
        payload: body.payload as string,
        deviceId: body.deviceId as string,
        ...(typeof body.checkpoint === "string" ? { checkpoint: body.checkpoint } : {}),
      });
      if (out.forbidden) throw new WizardError("FORBIDDEN");
      return c.json(out.body, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      return connectorFailure(c, e);
    }
  });

  // Offline manifest and sync arrive in M2 (qr.yaml#offline).
  app.all("*", () => {
    throw new WizardError("NOT_IMPLEMENTED");
  });
  return app;
}
