// /_wizard/qr/* (connectors/qr.yaml#endpoints, #checkin_algorithm, #offline). CSRF is enforced by app.ts for POST.
import { gzipSync } from "node:zlib";
import type { Integration } from "@wizard/appspec";
import {
  parseQrSyncBody,
  type QrConfig,
  type QrOfflineDenied,
  qrCheck,
  qrManifest,
  qrSync,
} from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { subjectOf } from "../http/subject.js";
import type { ConnectorHost } from "../preview/connectors.js";
import { connectorFailure, readObjectBody } from "../preview/http.js";
import { pgQrOfflineStore } from "../preview/qr-offline.js";

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

  const offline = (c: RuntimeContext) => {
    const integ = integrationOf(c, host);
    const sys = c.get("system");
    const ctx = host.ctx(sys, integ, c.get("host"));
    const store = pgQrOfflineStore(
      sys.data,
      integ.name,
      ctx.integration.config as QrConfig,
      c.get("services").clock,
    );
    return { ctx, store };
  };
  const refuse = (d: QrOfflineDenied): never => {
    throw new WizardError(
      "FORBIDDEN",
      d.reason === "offline_disabled" ? { message: "Офлайн-режим сканера не включён" } : {},
    );
  };

  // qr.yaml#offline.package: only h, id, display line and status; gzip when the client accepts it.
  app.get("/manifest", async (c) => {
    const { ctx, store } = offline(c);
    const subject = await subjectOf(c);
    try {
      const out = await qrManifest(ctx, subject.role, store, { since: c.req.query("since") ?? null });
      if (out.forbidden) return refuse(out);
      const json = JSON.stringify(out.body);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Vary: "Accept-Encoding",
      };
      if (!/\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) return c.body(json, 200, headers);
      return c.body(new Uint8Array(gzipSync(json)), 200, { ...headers, "Content-Encoding": "gzip" });
    } catch (e) {
      return connectorFailure(c, e);
    }
  });

  // qr.yaml#offline.sync_protocol: ≤ 500 events per call, idempotent by clientEventId, first check-in wins.
  app.post("/sync", async (c) => {
    const { ctx, store } = offline(c);
    const subject = await subjectOf(c);
    const parsed = parseQrSyncBody(await readObjectBody(c));
    if (!parsed.ok) {
      throw new WizardError("VALIDATION_FAILED", {
        fields: parsed.fields.map((f) => ({ ...f, code: "INVALID" })),
      });
    }
    try {
      const out = await qrSync(ctx, subject.role, store, { ...parsed.value, userId: subject.id });
      if (out.forbidden) return refuse(out);
      return c.json(out.body, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      return connectorFailure(c, e);
    }
  });

  app.all("*", () => {
    throw new WizardError("NOT_FOUND", { message: "Адрес не найден" });
  });
  return app;
}
