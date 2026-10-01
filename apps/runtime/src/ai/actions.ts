// AI actions of a loaded system (runtime.yaml#ai_actions, M3-02): one call = read the record as __system, send its
// source fields (text; images and PDF of file fields as attachments) to the platform gateway (T0 only), write the
// result into the target fields as __system and journal the fill in _w_audit (op ai_fill) — the source of the record
// meta `_aiFilled` that RecordCard marks «заполнено ИИ». A later write of such a field by anyone else clears the mark.
import {
  DEFAULT_MAX_LENGTH,
  type Field,
  quoteIdent,
  type ResolvedAiAction,
  resolveAiAction,
} from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { type DataTx, SYSTEM_ROLE, SYSTEM_SUBJECT } from "../data/access.js";
import type { LoadedSystem } from "../system.js";
import type { AiAttachmentMime, AiField, AiGatewayClient, AiRunRequest } from "./gateway.js";

/** _w_audit.op of an AI fill (fields = the target fields written). */
export const AI_FILL_OP = "ai_fill";
/** Images/PDF per call (each file ≤ 10 МБ, runtime.yaml#files). */
export const MAX_AI_ATTACHMENTS = 3;
const ATTACHMENT_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
/** Codes that stop a backfill: every further record would be refused the same way. */
export const AI_STOP_CODES: ReadonlySet<string> = new Set([
  "AI_LIMIT_REACHED",
  "AI_CREDITS_EXHAUSTED",
  "AI_UNAVAILABLE",
]);

export type AiSource = AiRunRequest["source"];

/** The action of the spec by name, resolved (ai-actions.ts of @wizard/appspec); unknown → 404. */
export function findAiAction(sys: LoadedSystem, name: string): ResolvedAiAction {
  const a = (sys.spec.aiActions ?? []).find((x) => x.name === name);
  const r = a ? resolveAiAction(sys.spec, a) : null;
  if (!r?.ok) throw new WizardError("NOT_FOUND", { message: "ИИ-действие не найдено" });
  return r.action;
}

/** A target field as the model sees it: label, type, choices, limits (default string length of the schema). */
export function aiField(f: Field): AiField {
  const maxLength = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type];
  return {
    name: f.name,
    label: f.label,
    type: f.type,
    ...(f.enum ? { options: f.enum.map((o) => ({ value: o.value, label: o.label })) } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
  };
}

function asText(f: Field, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (f.type === "enum") return f.enum?.find((o) => o.value === v)?.label ?? String(v);
  if (f.type === "bool") return v === true ? "да" : "нет";
  return typeof v === "string" ? v : String(v);
}

function SYSTEM_TX<T>(sys: LoadedSystem, mode: "read" | "write", fn: (d: DataTx) => Promise<T>): Promise<T> {
  return sys.data.transaction(mode, SYSTEM_SUBJECT, fn);
}

/** Gateway request of `a` for `row`: source values as text, file fields as attachments (multimodal → T0 only). */
export async function aiRequest(
  sys: LoadedSystem,
  a: ResolvedAiAction,
  row: Record<string, unknown>,
  call: { callId: string; source: AiSource },
): Promise<AiRunRequest> {
  const record: AiRunRequest["record"] = [];
  const attachments: NonNullable<AiRunRequest["attachments"]> = [];
  for (const f of a.inputs) {
    const v = row[f.name];
    if (f.type === "file") {
      if (typeof v !== "string" || !sys.files || attachments.length >= MAX_AI_ATTACHMENTS) continue;
      const obj = await sys.files.storage.get(sys.files.key(v));
      if (!obj || !ATTACHMENT_MIMES.has(obj.meta.mime)) continue;
      // File names are never sent (they may hold personal data); only the bytes go to the T0 model.
      attachments.push({
        mime: obj.meta.mime as AiAttachmentMime,
        data: Buffer.from(obj.data).toString("base64"),
      });
      continue;
    }
    const text = asText(f, v);
    if (text !== null) record.push({ label: f.label, value: text });
  }
  if (record.length === 0 && attachments.length === 0)
    throw new WizardError("VALIDATION_FAILED", {
      message: `Для ИИ-действия нет данных: заполните ${a.inputs.map((f) => `«${f.label}»`).join(", ")}`,
    });
  return {
    systemKey: sys.entry.systemId,
    env: sys.entry.env,
    callId: call.callId,
    source: call.source,
    monthlyLimit: a.monthlyLimit,
    action: { name: a.name, kind: a.kind, instruction: a.instruction, outputs: a.outputs.map(aiField) },
    record,
    ...(attachments.length ? { attachments } : {}),
  };
}

export interface AiRunOutcome {
  /** Target fields written by this call. */
  filled: string[];
  /** Target fields the model left empty or answered unusably (not written). */
  skipped: string[];
}

/** Runs `a` on one record; throws WizardError (NOT_FOUND, VALIDATION_FAILED, AI_* codes of the gateway). */
export async function runAiAction(
  sys: LoadedSystem,
  gateway: AiGatewayClient | null | undefined,
  i: { action: ResolvedAiAction; recordId: string; callId: string; source: AiSource },
): Promise<AiRunOutcome> {
  if (!gateway) throw new WizardError("AI_UNAVAILABLE");
  const entity = i.action.entity.name;
  const row = await SYSTEM_TX<Record<string, unknown> | null>(sys, "read", (d) =>
    d.system.get(entity, i.recordId),
  );
  if (!row) throw new WizardError("NOT_FOUND");
  const req = await aiRequest(sys, i.action, row, { callId: i.callId, source: i.source });
  const res = await gateway.run(req);
  const outputs = new Set(i.action.outputs.map((f) => f.name));
  const values = Object.fromEntries(Object.entries(res.values).filter(([k]) => outputs.has(k)));
  const filled = Object.keys(values);
  const skipped = i.action.outputs.map((f) => f.name).filter((n) => !filled.includes(n));
  if (filled.length === 0) return { filled, skipped };
  const T = `${quoteIdent(sys.schema)}.${quoteIdent("_w_audit")}`;
  await SYSTEM_TX<void>(sys, "write", async (d) => {
    await d.system.patch(entity, i.recordId, values);
    await d.sql.unsafe(
      `insert into ${T} (role, entity, record_id, op, fields) values ($1, $2, $3::uuid, $4, $5::text[])`,
      [SYSTEM_ROLE, entity, i.recordId, AI_FILL_OP, filled],
    );
  });
  return { filled, skipped };
}

/**
 * Record meta `_aiFilled` (ui-kit.yaml#components.RecordCard «заполнено ИИ»): target fields whose last write was an AI
 * fill. The journal is folded in order: an ai_fill marks its fields, any other update of a field unmarks it (the AI's
 * own update row precedes its ai_fill row in the same transaction).
 */
export async function aiFilledFields(
  sys: LoadedSystem,
  entity: string,
  id: string,
  targets: ReadonlySet<string>,
): Promise<string[]> {
  if (targets.size === 0) return [];
  const T = `${quoteIdent(sys.schema)}.${quoteIdent("_w_audit")}`;
  const rows = await SYSTEM_TX(sys, "read", async (d) =>
    (
      await d.sql.unsafe(
        `select op, fields from ${T} where entity = $1 and record_id = $2::uuid
         and op in ('update', $3) and fields && $4::text[] order by id`,
        [entity, id, AI_FILL_OP, [...targets]],
      )
    ).map((r) => ({ op: String(r.op), fields: (r.fields as string[] | null) ?? null })),
  );
  const marked = new Set<string>();
  for (const r of rows)
    for (const f of r.fields ?? []) {
      if (!targets.has(f)) continue;
      if (r.op === AI_FILL_OP) marked.add(f);
      else marked.delete(f);
    }
  return [...targets].filter((f) => marked.has(f));
}

export interface BackfillReport {
  filled: number;
  skipped: number;
  stopCode: string | null;
}

/**
 * One-time backfill (runtime.yaml#ai_actions.triggers, by the change card flag): records whose target fields are all
 * empty, oldest first, at most monthlyLimit of them; call ids bf:<backfillId>:<recordId> make a repeated backfill
 * neither count nor charge twice. Stops at the first limit/credits/availability refusal.
 */
export async function backfillAiAction(
  sys: LoadedSystem,
  gateway: AiGatewayClient | null | undefined,
  i: { action: ResolvedAiAction; backfillId: string },
): Promise<BackfillReport> {
  const a = i.action;
  const T = `${quoteIdent(sys.schema)}.${quoteIdent(a.entity.name)}`;
  const empty = a.outputs
    .map((f) =>
      f.type === "string" || f.type === "text"
        ? `coalesce(${quoteIdent(f.name)}::text, '') = ''`
        : `${quoteIdent(f.name)} is null`,
    )
    .join(" and ");
  const ids = await SYSTEM_TX<string[]>(sys, "read", async (d) =>
    (
      await d.sql.unsafe(`select id::text as id from ${T} where ${empty} order by created_at, id limit $1`, [
        a.monthlyLimit,
      ])
    ).map((r) => String(r.id)),
  );
  const report: BackfillReport = { filled: 0, skipped: 0, stopCode: null };
  for (const id of ids) {
    try {
      const out = await runAiAction(sys, gateway, {
        action: a,
        recordId: id,
        callId: `bf:${i.backfillId}:${id}`,
        source: "backfill",
      });
      if (out.filled.length > 0) report.filled += 1;
      else report.skipped += 1;
    } catch (e) {
      const code = e instanceof WizardError ? e.code : "INTERNAL";
      if (AI_STOP_CODES.has(code)) {
        report.stopCode = code;
        break;
      }
      report.skipped += 1;
    }
  }
  return report;
}
