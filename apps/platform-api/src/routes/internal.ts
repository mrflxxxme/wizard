// Internal RPC of the runtime (runtime.yaml#ai_actions.call, M3-02): POST /internal/v1/ai/run with
// X-Wizard-Internal-Token (WIZARD_INTERNAL_TOKEN). No session, no Origin: the endpoint is for the runtime only; in the
// cloud the ingress does not route /internal/* (only the ClusterIP service). Without a configured token → 404.
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  AI_GATEWAY_STATUS,
  AI_MESSAGES,
  type AiGateway,
  AiGatewayError,
  aiRunSchema,
} from "../ai/gateway.js";
import type { Config } from "../config.js";

/** JSON body cap: up to 3 attachments of ≤ 10 МБ as base64 plus the record (runtime.yaml#files: files ≤ 10 МБ). */
export const AI_RUN_MAX_BYTES = 45 * 1024 * 1024;

export function internalTokenOk(expected: string | null, header: string | undefined): boolean {
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function internalRoutes(d: {
  config: Config;
  gateway: AiGateway;
  log?: (msg: string, err?: unknown) => void;
}): Hono {
  const app = new Hono();
  const fail = (status: number, code: string, message_ru: string) =>
    new Response(JSON.stringify({ code, message_ru }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  app.post("/ai/run", async (c) => {
    if (!d.config.internalToken) return fail(404, "NOT_FOUND", "Не найдено");
    if (!internalTokenOk(d.config.internalToken, c.req.header("x-wizard-internal-token")))
      return fail(403, "FORBIDDEN", "Доступ запрещён");
    if (Number(c.req.header("content-length") ?? "0") > AI_RUN_MAX_BYTES)
      return fail(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос");
    const text = await c.req.text();
    if (text.length > AI_RUN_MAX_BYTES) return fail(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return fail(400, "VALIDATION_FAILED", AI_MESSAGES.VALIDATION_FAILED);
    }
    const parsed = aiRunSchema.safeParse(raw);
    if (!parsed.success) return fail(400, "VALIDATION_FAILED", AI_MESSAGES.VALIDATION_FAILED);
    try {
      return c.json(await d.gateway.run(parsed.data));
    } catch (e) {
      if (e instanceof AiGatewayError) return fail(AI_GATEWAY_STATUS[e.code], e.code, e.message);
      d.log?.("internal ai/run failed", e);
      return fail(500, "INTERNAL", "Внутренняя ошибка, мы уже разбираемся");
    }
  });

  return app;
}
