// QR connector: specs/connectors/qr.yaml (M0 — online check-in).
import type { AppSpec } from "@wizard/appspec";
import { z } from "zod";
import { defineAction, defineConnector } from "./define.js";
import { ConnectorError, UniqueViolation } from "./errors.js";
import { parseQrKeyring, parseQrPayload, qrTokenHash, signQrToken, verifyQrToken } from "./qr-token.js";
import {
  entityOf,
  enumValues,
  fieldOf,
  hasPermission,
  Issues,
  ident,
  isUniqueField,
  requireEntity,
  requireField,
} from "./spec-util.js";
import type { ConnectorCtx, Row, SpecCheckContext } from "./types.js";

export const QR_SECRET = "qr_signing_key";

export const qrConfigSchema = z.strictObject({
  entity: ident,
  tokenField: ident,
  validStatuses: z.array(ident).min(1, { error: "Нужен хотя бы один статус, при котором проход разрешён" }),
  checkin: z.strictObject({ entity: ident, refField: ident }),
  displayFields: z.array(ident).max(5).optional(),
  offline: z.boolean().optional(),
  scannerRoles: z.array(ident).min(1, { error: "Нужна хотя бы одна роль сканера" }),
});
export type QrConfig = z.infer<typeof qrConfigSchema>;

export function validateQrSpec(config: QrConfig, spec: AppSpec, at: SpecCheckContext) {
  const issues = new Issues(at);
  const carrier = requireEntity(spec, issues, "qr.entity", ["entity"], config.entity);
  if (carrier) {
    requireField(carrier, issues, "qr.token_field", ["tokenField"], config.tokenField, ["qr_token"]);
    const status = requireField(carrier, issues, "qr.status_field", ["entity"], "status", ["enum"]);
    if (status) {
      const values = enumValues(status);
      config.validStatuses.forEach((s, i) => {
        if (!values.includes(s)) {
          issues.add(
            "qr.valid_status",
            ["validStatuses", i],
            `Статуса «${s}» нет в поле «${carrier.name}.status»`,
            values,
          );
        }
      });
    }
    (config.displayFields ?? []).forEach((f, i) => {
      requireField(carrier, issues, "qr.display_field", ["displayFields", i], f);
    });
  }
  const checkin = requireEntity(
    spec,
    issues,
    "qr.checkin_entity",
    ["checkin", "entity"],
    config.checkin.entity,
  );
  if (checkin) {
    const ref = requireField(
      checkin,
      issues,
      "qr.checkin_ref",
      ["checkin", "refField"],
      config.checkin.refField,
      ["ref"],
    );
    if (ref && ref.ref?.entity !== config.entity) {
      issues.add(
        "qr.checkin_ref_target",
        ["checkin", "refField"],
        `Поле «${checkin.name}.${ref.name}» должно ссылаться на сущность «${config.entity}»`,
      );
    }
    if (ref && !isUniqueField(checkin, ref.name)) {
      issues.add(
        "qr.checkin_ref_unique",
        ["checkin", "refField"],
        `Поле «${checkin.name}.${ref.name}» должно быть уникальным: один билет — одна отметка входа`,
      );
    }
    requireField(checkin, issues, "qr.checkin_scanned_at", ["checkin", "entity"], "scanned_at", ["datetime"]);
  }
  config.scannerRoles.forEach((name, i) => {
    const role = spec.roles.find((r) => r.name === name);
    const rel = ["scannerRoles", i];
    if (!role) {
      issues.add(
        "qr.scanner_role",
        rel,
        `Роль «${name}» не найдена`,
        spec.roles.map((r) => r.name),
      );
      return;
    }
    if (role.access === "public" || role.selfSignup) {
      issues.add(
        "qr.scanner_role_open",
        rel,
        `Роль «${name}» доступна без приглашения — сканировать билеты ей нельзя`,
      );
    }
    if (!hasPermission(spec, name, config.checkin.entity, "create")) {
      issues.add(
        "qr.scanner_role_create",
        rel,
        `Роль «${name}» должна иметь право создавать «${config.checkin.entity}»`,
      );
    }
  });
  return issues.list;
}

async function keyring(ctx: ConnectorCtx) {
  return parseQrKeyring(await ctx.secrets.get(QR_SECRET));
}

function scope(ctx: ConnectorCtx) {
  return { systemId: ctx.system.id, env: ctx.system.env };
}

const revokedKey = (hash: string) => `qr:revoked:${hash}`;
const REVOKED_TTL_MS = 400 * 24 * 60 * 60_000;

/** Value for the qr_token field of a new carrier row (runtime insert hook). */
export async function issueQrToken(ctx: ConnectorCtx): Promise<string> {
  return signQrToken(await keyring(ctx), scope(ctx));
}

async function revoke(ctx: ConnectorCtx, input: { entity: string; id: string }): Promise<void> {
  const config = ctx.integration.config as QrConfig;
  if (input.entity !== config.entity) {
    throw new ConnectorError("INVALID_REQUEST", `Сущность «${input.entity}» не использует QR-билеты`);
  }
  const row = await ctx.db.get(config.entity, input.id);
  if (!row) throw new ConnectorError("NOT_FOUND", "Запись не найдена");
  const old =
    typeof row[config.tokenField] === "string" ? parseQrPayload(row[config.tokenField] as string) : null;
  if (old) await ctx.store.set(revokedKey(qrTokenHash(old.rand)), true, REVOKED_TTL_MS);
  await ctx.db.patch(config.entity, input.id, { [config.tokenField]: await issueQrToken(ctx) });
}

export interface QrCheckInput {
  payload: string;
  checkpoint?: string;
  deviceId: string;
}

export interface QrCheckResponse {
  status: "ok" | "duplicate" | "invalid";
  reason?: "not_found" | "bad_signature" | "revoked" | "not_valid_status";
  ticketTitle?: string;
  details?: Record<string, string>;
  scannedAt: string;
  firstScannedAt?: string;
  firstCheckpoint?: string;
}

function refLabel(spec: AppSpec, entity: string, row: Row | null): string {
  if (!row) return "";
  for (const k of ["name", "title", "label"]) if (typeof row[k] === "string") return row[k] as string;
  const firstText = entityOf(spec, entity)?.fields.find((f) => f.type === "string");
  return firstText ? String(row[firstText.name] ?? "") : "";
}

async function display(ctx: ConnectorCtx, config: QrConfig, row: Row) {
  const spec = ctx.system.spec;
  const carrier = entityOf(spec, config.entity);
  const details: Record<string, string> = {};
  for (const name of config.displayFields ?? []) {
    const field = fieldOf(carrier, name);
    const v = row[name];
    if (v === null || v === undefined || v === "") continue;
    if (field?.type === "ref" && field.ref) {
      details[name] = refLabel(spec, field.ref.entity, await ctx.db.get(field.ref.entity, String(v)));
    } else if (field?.type === "enum") {
      details[name] = field.enum?.find((o) => o.value === v)?.label ?? String(v);
    } else {
      details[name] = String(v);
    }
  }
  return { details, ticketTitle: Object.values(details).filter(Boolean).join(" · ") };
}

/** POST /_wizard/qr/check (qr.yaml#checkin_algorithm). `role` is the caller's role; 403 → `forbidden`. */
export async function qrCheck(
  ctx: ConnectorCtx,
  role: string,
  input: QrCheckInput,
): Promise<{ forbidden: true } | { forbidden: false; body: QrCheckResponse }> {
  const config = ctx.integration.config as QrConfig;
  if (!config.scannerRoles.includes(role)) return { forbidden: true };
  const scannedAt = ctx.now().toISOString();
  const invalid = (reason: QrCheckResponse["reason"]) => ({
    forbidden: false as const,
    body: { status: "invalid" as const, reason, scannedAt },
  });

  const verified = verifyQrToken(input.payload, await keyring(ctx), scope(ctx), ctx.now());
  if (!verified.ok) return invalid("bad_signature");
  const row = await ctx.db.getBy(config.entity, config.tokenField, input.payload);
  if (!row) {
    const revoked = await ctx.store.get(revokedKey(qrTokenHash(verified.rand)));
    return invalid(revoked ? "revoked" : "not_found");
  }
  if (!config.validStatuses.includes(String(row.status))) return invalid("not_valid_status");

  const shown = await display(ctx, config, row);
  const checkinEntity = entityOf(ctx.system.spec, config.checkin.entity);
  const doc: Record<string, unknown> = { [config.checkin.refField]: row.id, scanned_at: scannedAt };
  const optional: Record<string, unknown> = {
    device_id: input.deviceId,
    gate: input.checkpoint,
    offline: false,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v !== undefined && fieldOf(checkinEntity, k)) doc[k] = v;
  }
  try {
    await ctx.db.insert(config.checkin.entity, doc);
    return { forbidden: false, body: { status: "ok", scannedAt, ...shown } };
  } catch (e) {
    if (!(e instanceof UniqueViolation)) throw e;
    const first = await ctx.db.getBy(config.checkin.entity, config.checkin.refField, row.id);
    const body: QrCheckResponse = { status: "duplicate", scannedAt, ...shown };
    if (first?.scanned_at) body.firstScannedAt = String(first.scanned_at);
    if (typeof first?.gate === "string") body.firstCheckpoint = first.gate;
    return { forbidden: false, body };
  }
}

const revokeInput = z.strictObject({
  entity: ident,
  id: z.string().min(1),
  idempotencyKey: z.string().optional(),
});

export const qrConnector = defineConnector({
  id: "qr",
  milestone: "M0",
  configSchema: qrConfigSchema,
  secrets: [
    {
      name: QR_SECRET,
      required: true,
      label: "Ключ подписи QR — генерирует платформа (32 байта), пользователь его не вводит",
    },
  ],
  validateSpec: validateQrSpec,
  actions: {
    revoke: defineAction({
      input: revokeInput,
      output: z.void(),
      effect: true,
      retry: null,
      handler: (ctx, input) => revoke(ctx, input),
    }),
  },
  testMode: (env) => (env === "draft" ? "test" : "live"),
  piiFields: [],
});
