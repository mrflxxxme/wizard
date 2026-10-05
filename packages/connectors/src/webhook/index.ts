// Universal incoming webhook (M2-53, D71; specs/connectors/webhook.yaml): a secret path per integration, verification
// by HMAC over the raw body (header and algorithm from a closed list) or a shared secret, replay protection by event
// id or body hash (signed hooks: also by the body hash whatever the unsigned event id), an allowlist mapping of payload
// keys to fields of one entity (never file or image fields). The runtime
// route (apps/runtime/src/routes/webhook.ts) owns HTTP, rate limits, the _w_webhook_events journal and the insert.
import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  type AppSpec,
  type Entity,
  isFileFieldType,
  SECRET_REF_RE,
  SYSTEM_FIELDS,
  USERS_ENTITY,
} from "@wizard/appspec";
import { z } from "zod";
import { defineConnector } from "../define.js";
import { parseSecretRef } from "../secrets.js";
import { entityOf, fieldOf, IDENT_RE, Issues } from "../spec-util.js";
import { secretMatches } from "../telegram.js";
import type { SecretReader, SpecCheckContext, SpecIssue } from "../types.js";

/** Secret names of webhook integrations: secret://webhook_<name> (one per integration). */
export const WEBHOOK_SECRET_PREFIX = "webhook_";
/** connector-interface.md §2 «Вебхуки» for this connector: body ≤ 64 KiB, ≤ 60 requests a minute per integration. */
export const INCOMING_WEBHOOK_BODY_MAX = 64 * 1024;
export const INCOMING_WEBHOOK_RATE_PER_MINUTE = 60;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Hop-by-hop and platform headers a webhook config may not name. */
const RESERVED_HEADERS = new Set([
  "host",
  "cookie",
  "content-length",
  "content-type",
  "x-forwarded-for",
  "connection",
]);
const PAYLOAD_KEY_RE = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,3}$/;
const header = z
  .string()
  .regex(HEADER_RE, { error: "Имя заголовка: латиница, цифры и дефис" })
  .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()), {
    error: "Этот заголовок задаёт сервер, а не отправитель",
  });

export const webhookConfigSchema = z
  .strictObject({
    /** hmac — подпись тела в заголовке; shared_secret — секретный адрес (+ заголовок с секретом, если задан secret). */
    verify: z.enum(["hmac", "shared_secret"]),
    secret: z.string().regex(SECRET_REF_RE, { error: "Секрет — ссылка secret://webhook_<имя>" }).optional(),
    header: header.optional(),
    algorithm: z.enum(["sha256", "sha1", "sha512"]).optional(),
    encoding: z.enum(["hex", "base64"]).optional(),
    /** Prefix of the signature value, e.g. «sha256=». */
    prefix: z.string().max(20).optional(),
    /** Signed payload = `<timestamp>.<body>` and the timestamp (unix seconds) must be within toleranceSeconds. */
    timestampHeader: header.optional(),
    toleranceSeconds: z.number().int().min(30).max(3600).optional(),
    eventIdHeader: header.optional(),
    eventIdField: z.string().regex(PAYLOAD_KEY_RE).optional(),
    entity: z.string().regex(IDENT_RE),
    /** target field → payload key («a.b» for nested JSON); everything else in the payload is ignored. */
    fields: z.record(z.string().regex(IDENT_RE), z.string().regex(PAYLOAD_KEY_RE)),
    /** Raising it rotates the secret address (the old one stops working). */
    tokenVersion: z.number().int().min(1).max(1000).optional(),
  })
  .superRefine((c, ctx) => {
    if (Object.keys(c.fields).length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: "Укажите хотя бы одно поле записи из данных вебхука",
      });
    if (c.verify === "hmac") {
      if (!c.secret)
        ctx.addIssue({
          code: "custom",
          path: ["secret"],
          message: "Для подписи нужен секрет secret://webhook_<имя>",
        });
      if (!c.header)
        ctx.addIssue({ code: "custom", path: ["header"], message: "Укажите заголовок с подписью" });
    } else {
      if (c.secret && !c.header)
        ctx.addIssue({
          code: "custom",
          path: ["header"],
          message: "Укажите заголовок, в котором приходит общий секрет",
        });
      for (const k of ["algorithm", "encoding", "prefix", "timestampHeader"] as const)
        if (c[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            path: [k],
            message: "Этот параметр нужен только для проверки подписи (verify: hmac)",
          });
    }
  });
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/** G0: target entity and fields exist and are writable by a webhook (no system, owner, user-ref, file, QR fields). */
export function validateWebhookSpec(config: WebhookConfig, spec: AppSpec, at: SpecCheckContext): SpecIssue[] {
  const issues = new Issues(at);
  const entity = entityOf(spec, config.entity);
  if (!entity) {
    issues.add(
      "webhook.entity",
      ["entity"],
      `Сущность «${config.entity}» не найдена`,
      spec.entities.map((e) => e.name),
    );
  } else {
    for (const target of Object.keys(config.fields)) {
      const f = fieldOf(entity, target);
      const why = !f
        ? `Поля «${target}» нет в сущности «${entity.name}»`
        : (SYSTEM_FIELDS as readonly string[]).includes(target) ||
            target === entity.ownerField ||
            (f.type === "ref" && f.ref?.entity === USERS_ENTITY) ||
            isFileFieldType(f.type) ||
            f.type === "qr_token"
          ? `Поле «${target}» нельзя заполнять из вебхука (системное, владелец записи, файл, картинка или QR)`
          : null;
      if (why) issues.add("webhook.field", ["fields", target], why);
    }
  }
  if (config.secret) {
    const name = parseSecretRef(config.secret);
    if (!name?.startsWith(WEBHOOK_SECRET_PREFIX))
      issues.add("webhook.secret_name", ["secret"], "Секрет вебхука называется secret://webhook_<имя>");
    else if (!(at.integration.secretRefs ?? []).includes(config.secret))
      issues.add("webhook.secret_declared", ["secret"], `Объявите ${config.secret} в secretRefs интеграции`);
  }
  const out: SpecIssue[] = [...issues.list];
  (spec.workflows ?? []).forEach((w, wi) => {
    if (w.trigger.type !== "webhook" || w.trigger.integration !== at.integration.name) return;
    if (w.trigger.entity !== undefined && w.trigger.entity !== config.entity)
      out.push({
        code: "CONFIG_INVALID",
        path: `/workflows/${wi}/trigger/entity`,
        message_ru: `Вебхук «${at.integration.name}» создаёт записи «${config.entity}», а не «${w.trigger.entity}»`,
        rule: "webhook.trigger_entity",
      });
  });
  return out;
}

/** Workflows started by this webhook integration (trigger {type: webhook, integration}). */
export function webhookWorkflows(spec: AppSpec, integration: string) {
  return (spec.workflows ?? []).filter(
    (w) => w.trigger.type === "webhook" && w.trigger.integration === integration,
  );
}

// ------------------------------------------------------------------------------------------------ secret address

/** Dev fallback of the key outside production (platform-api and runtime derive the same addresses locally). */
export const DEV_WEBHOOK_KEY = "wizard-dev-webhook-key-not-for-production";

/** Key material of hook tokens: WIZARD_SECRETS_KEY (shared by platform-api and runtime), dev fallback otherwise. */
export function webhookKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const k = env.WIZARD_SECRETS_KEY;
  if (k && k.length >= 32) return k;
  if (env.NODE_ENV === "production")
    throw new Error("WIZARD_SECRETS_KEY (≥ 32 chars) is required for webhooks");
  return DEV_WEBHOOK_KEY;
}

/** 43 chars [A-Za-z0-9_-] (256 bits): the secret path segment of /_wizard/hooks/webhook/<integration>/<hookToken>. */
export function webhookHookToken(
  key: string,
  a: { systemId: string; env: "draft" | "prod"; integration: string; version?: number },
): string {
  const sub = Buffer.from(
    hkdfSync("sha256", Buffer.from(key, "utf8"), Buffer.alloc(0), "wizard-webhook-path", 32),
  );
  return createHmac("sha256", sub)
    .update(`${a.systemId}\0${a.env}\0${a.integration}\0${a.version ?? 1}`)
    .digest("base64url");
}

/** Absolute address the owner pastes into the sending service. */
export function webhookUrl(origin: string, integration: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/_wizard/hooks/webhook/${encodeURIComponent(integration)}/${token}`;
}

// ------------------------------------------------------------------------------------------------ verification

export interface IncomingWebhook {
  headers: Headers;
  body: Uint8Array;
  /** Request time (ms). */
  now: number;
}

export type WebhookVerdict =
  | { ok: true; eventKey: string; bodyHash: Buffer; payload: Record<string, unknown> }
  | { ok: false; status: 401 | 422; reason: string };

const DEFAULT_TOLERANCE_S = 300;

function hmacMatches(
  config: WebhookConfig,
  secret: string,
  signed: Buffer,
  presented: string | null,
): boolean {
  if (!presented) return false;
  const prefix = config.prefix ?? "";
  // Several signatures in one header (key rotation, «v1=…,v1=…»): any match is enough.
  const candidates = presented
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (prefix && s.startsWith(prefix) ? s.slice(prefix.length) : prefix ? null : s))
    .filter((s): s is string => s !== null);
  const expected = createHmac(config.algorithm ?? "sha256", secret)
    .update(signed)
    .digest(config.encoding ?? "hex");
  return candidates.some((c) => secretMatches(config.encoding === "base64" ? c : c.toLowerCase(), expected));
}

/** Parses a JSON object or an application/x-www-form-urlencoded body (Tilda and most form services). */
export function parseWebhookBody(
  contentType: string | null,
  body: Uint8Array,
): Record<string, unknown> | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  if ((contentType ?? "").toLowerCase().includes("application/x-www-form-urlencoded")) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) if (!Object.hasOwn(out, k)) out[k] = v;
    return out;
  }
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pick(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const k of path.split(".")) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur) || !Object.hasOwn(cur, k))
      return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Checks the request (signature or shared secret, timestamp window) and derives the replay key: the event id
 * (header or payload field) or the body hash. The secret address itself is checked by the caller before this.
 */
export async function verifyWebhook(
  config: WebhookConfig,
  secrets: SecretReader,
  req: IncomingWebhook,
): Promise<WebhookVerdict> {
  const bodyHash = createHash("sha256").update(req.body).digest();
  const deny = (reason: string): WebhookVerdict => ({ ok: false, status: 401, reason });
  let ts: string | null = null;
  if (config.timestampHeader) {
    ts = req.headers.get(config.timestampHeader);
    const sec = ts !== null && /^\d{9,11}$/.test(ts) ? Number(ts) : Number.NaN;
    if (!Number.isFinite(sec)) return deny("timestamp_missing");
    if (Math.abs(req.now / 1000 - sec) > (config.toleranceSeconds ?? DEFAULT_TOLERANCE_S))
      return deny("timestamp_window");
  }
  const secretName = config.secret ? parseSecretRef(config.secret) : null;
  if (config.verify === "hmac") {
    if (!secretName || !config.header) return deny("config");
    const secret = await secrets.get(secretName);
    const signed =
      ts !== null ? Buffer.concat([Buffer.from(`${ts}.`), Buffer.from(req.body)]) : Buffer.from(req.body);
    if (!hmacMatches(config, secret, signed, req.headers.get(config.header))) return deny("signature");
  } else if (secretName && config.header) {
    const secret = await secrets.get(secretName);
    if (!secretMatches(req.headers.get(config.header), secret)) return deny("shared_secret");
  }
  const payload = parseWebhookBody(req.headers.get("content-type"), req.body);
  if (!payload) return { ok: false, status: 422, reason: "body" };
  const id = config.eventIdHeader
    ? req.headers.get(config.eventIdHeader)
    : config.eventIdField
      ? pick(payload, config.eventIdField)
      : null;
  const eventKey =
    typeof id === "string" && id !== "" && id.length <= 200
      ? `id:${id}`
      : typeof id === "number" && Number.isFinite(id)
        ? `id:${id}`
        : `body:${bodyHash.toString("hex")}`;
  return { ok: true, eventKey, bodyHash, payload };
}

/**
 * The record a webhook writes: only mapped fields, scalar values (strings trimmed to the field's maxLength or 10 000);
 * keys outside the map, nested objects and arrays are ignored.
 */
export function mapWebhookFields(config: WebhookConfig, entity: Entity, payload: Record<string, unknown>) {
  const doc: Record<string, unknown> = {};
  for (const [target, key] of Object.entries(config.fields)) {
    const f = fieldOf(entity, target);
    // file/image hold a fileId of an own upload, qr_token is issued by the platform: never from a webhook (G0 refuses).
    if (!f || isFileFieldType(f.type) || f.type === "qr_token") continue;
    const v = pick(payload, key);
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string") {
      const max = Math.min(f.maxLength ?? 10_000, 10_000);
      if (f.type === "bool") doc[target] = ["1", "true", "yes", "on", "да"].includes(v.trim().toLowerCase());
      else if (["int", "decimal", "money"].includes(f.type) && v.trim() !== "" && Number.isFinite(Number(v)))
        doc[target] = Number(v);
      else doc[target] = [...v].slice(0, max).join("");
    } else if (typeof v === "number" || typeof v === "boolean") doc[target] = v;
  }
  return doc;
}

export const webhookConnector = defineConnector({
  id: "webhook",
  milestone: "M2",
  configSchema: webhookConfigSchema,
  secrets: [],
  secretPrefix: WEBHOOK_SECRET_PREFIX,
  validateSpec: validateWebhookSpec,
  actions: {},
  testMode: () => "live",
  piiFields: ["payload"],
});
