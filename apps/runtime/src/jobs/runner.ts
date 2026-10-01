// Minimal job runner (runtime.yaml#workflows, M1): workflow triggers from _w_audit (on_create/on_update/
// on_status), schedule triggers (relative, cron), due _w_jobs (function, workflow_step) and retention. runJobs is
// one pass at a given `now` until nothing is due (G1 runWorkflows/advanceTime); the background poller comes later.
import { type Entity, quoteIdent, resolveAiAction, type Workflow } from "@wizard/appspec";
import { isConnectorError, runNotifyStep } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { SYSTEM_USER } from "@wizard/sdk/host";
import type postgres from "postgres";
import { findAiAction, runAiAction } from "../ai/actions.js";
import { SYSTEM_ROLE, SYSTEM_SUBJECT } from "../data/access.js";
import { outboxConnectors, systemFunctions } from "../exec/host.js";
import type { RuntimeServices } from "../http/context.js";
import { logDeletions, retainUsers, runDueErasures } from "../privacy/erasure.js";
import type { LoadedSystem } from "../system.js";
import { DEFAULT_TIMEZONE, lastOccurrence, parseCron } from "./cron.js";

export interface RunJobsOptions {
  /** Frozen time of the pass (G1 advanceTime); default: the runtime clock. */
  now?: Date;
  /** Lower bound of the cron window when the system has no cursor yet (default: now → nothing fires). */
  since?: Date;
  /** Trigger → execute rounds (jobs may write records that trigger more workflows); default 20. */
  maxRounds?: number;
}

export interface JobFailure {
  jobId: string;
  kind: "function" | "workflow_step";
  /** Function or workflow name. */
  name: string;
  /** Step index of a workflow (0-based). */
  step?: number;
  stepType?: string;
  /** Error code only: messages may carry values (no pii in reports). */
  code: string;
  /** No more attempts (5). */
  dead: boolean;
}

export interface RetentionResult {
  entity: string;
  /** consent_revoked — anonymization of a withdrawn consent that came due (privacy/erasure.ts). */
  mode: "delete" | "anonymize" | "consent_revoked";
  rows: number;
}

export interface RunJobsReport {
  now: string;
  /** Jobs executed successfully. */
  ran: number;
  failed: JobFailure[];
  retention: RetentionResult[];
  /** Jobs due at `now` still waiting (only when maxRounds ran out). */
  pending: number;
}

type Row = Record<string, unknown>;
type Tx = postgres.TransactionSql;

interface Cursor {
  audit: string;
  at: string | null;
}

interface JobRow {
  id: string;
  kind: string;
  payload: Row;
  attempts: number;
}

interface WorkflowPayload {
  workflow: string;
  entity?: string;
  recordId?: string;
  step?: number;
}

const CURSOR_KEY = "__wizard_cursor";
const MAX_ATTEMPTS = 5;
const BATCH = 50;
const LEASE = "5 minutes";
const MINUTE = 60_000;
const RECORD_REF_RE = /^\$record\.([a-z_][a-z0-9_]*)$/;
const TEMPLATE_RE = /\{\{\s*([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?\s*\}\}/g;

/** Retry delay after `attempt` failures: 1 s × 4^(n-1), at most 16 min (runtime.yaml#workflows.execution). */
export const backoffMs = (attempt: number) => Math.min(1000 * 4 ** Math.max(0, attempt - 1), 16 * MINUTE);

const errorCode = (e: unknown) => (e instanceof WizardError ? e.code : "INTERNAL");

class StepFailure extends Error {
  constructor(
    readonly step: number,
    readonly stepType: string,
    readonly code: string,
  ) {
    super(code);
  }
}

const piiFields = (e: Entity) =>
  e.fields.filter((f) => (f.pii ?? (f.type === "file" ? "basic" : "none")) !== "none").map((f) => f.name);

export async function runJobs(
  sys: LoadedSystem,
  services: RuntimeServices,
  o: RunJobsOptions = {},
): Promise<RunJobsReport> {
  const spec = sys.spec;
  const now = o.now ?? services.clock();
  const S = quoteIdent(sys.schema);
  const T = (table: string) => `${S}.${quoteIdent(table)}`;
  const report: RunJobsReport = { now: now.toISOString(), ran: 0, failed: [], retention: [], pending: 0 };
  const system = <R>(fn: (tx: Tx) => Promise<R>) =>
    sys.data.transaction("default", SYSTEM_SUBJECT, (d) => fn(d.sql));

  const readCursor = async (tx: Tx): Promise<Cursor> => {
    const rows = await tx.unsafe(`select payload from ${T("_w_jobs")} where idempotency_key = $1`, [
      CURSOR_KEY,
    ]);
    const p = (rows[0]?.payload ?? {}) as Partial<Cursor>;
    return { audit: typeof p.audit === "string" ? p.audit : "0", at: typeof p.at === "string" ? p.at : null };
  };
  const writeCursor = (tx: Tx, c: Cursor) =>
    tx.unsafe(
      `insert into ${T("_w_jobs")} (kind, payload, run_at, locked_until, idempotency_key)
       values ('workflow_step', cast($1::text as jsonb), 'infinity', 'infinity', $2)
       on conflict (idempotency_key) do update set payload = excluded.payload`,
      [JSON.stringify({ state: "cursor", ...c }), CURSOR_KEY],
    );
  const enqueue = async (tx: Tx, kind: string, payload: Row, runAt: Date, key: string) => {
    const r = await tx.unsafe(
      `insert into ${T("_w_jobs")} (kind, payload, run_at, idempotency_key)
       values ($1, cast($2::text as jsonb), $3::timestamptz, $4) on conflict (idempotency_key) do nothing`,
      [kind, JSON.stringify(payload), runAt.toISOString(), key],
    );
    return r.count;
  };
  const wfJob = (w: Workflow, entity?: string, recordId?: string): Row => ({
    workflow: w.name,
    ...(entity ? { entity } : {}),
    ...(recordId ? { recordId } : {}),
    step: 0,
  });

  /**
   * Target fields of the workflow's own AI steps (M3-02): an on_update of only these fields is the workflow's own AI
   * fill and does not start it again (no loop when the trigger has no field or watches an AI target).
   */
  const ownAiFields = (w: Workflow): Set<string> => {
    const out = new Set<string>();
    for (const st of w.steps) {
      if (st.type !== "ai_extract" && st.type !== "ai_generate") continue;
      const a = (spec.aiActions ?? []).find((x) => x.name === (st.params as Row | undefined)?.action);
      const r = a ? resolveAiAction(spec, a) : null;
      if (r?.ok) for (const f of r.action.outputs) out.add(f.name);
    }
    return out;
  };

  // ---------- triggers ----------

  /** on_create / on_update / on_status from new _w_audit rows; the cursor moves in the same transaction. */
  const auditTriggers = () =>
    system(async (tx) => {
      const cursor = await readCursor(tx);
      const rows = await tx.unsafe(
        `select id::text as id, entity, record_id::text as record_id, op, fields from ${T("_w_audit")}
         where id > $1::bigint order by id limit 1000`,
        [cursor.audit],
      );
      const last = rows.at(-1);
      if (!last) return 0;
      let n = 0;
      for (const w of spec.workflows ?? []) {
        const tr = w.trigger;
        if (!tr.entity || !["on_create", "on_update", "on_status"].includes(tr.type)) continue;
        const mine = rows.filter((r) => r.entity === tr.entity && typeof r.record_id === "string");
        const has = (r: Row) => tr.field === undefined || (r.fields as string[] | null)?.includes(tr.field);
        if (tr.type === "on_create" || tr.type === "on_update") {
          const op = tr.type === "on_create" ? "create" : "update";
          const own = ownAiFields(w);
          const ownFill = (r: Row) =>
            own.size > 0 && ((r.fields as string[] | null) ?? []).every((f) => own.has(f));
          for (const r of mine.filter((x) => x.op === op && (op === "create" || (has(x) && !ownFill(x)))))
            n += await enqueue(
              tx,
              "workflow_step",
              wfJob(w, tr.entity, r.record_id as string),
              now,
              `wf:${w.name}:a${r.id}`,
            );
          continue;
        }
        if (tr.field === undefined) continue;
        // on_status: the last write of the field per record, if the record now holds `equals`.
        const byRecord = new Map<string, Row>();
        for (const r of mine)
          if (r.op === "create" || (r.op === "update" && has(r))) byRecord.set(r.record_id as string, r);
        for (const r of byRecord.values()) {
          const cur = await tx.unsafe(
            `select ${quoteIdent(tr.field)}::text as v from ${T(tr.entity)} where id = $1::uuid`,
            [r.record_id as string],
          );
          const v: unknown = cur[0]?.v;
          if (v !== null && v !== undefined && String(v) === String(tr.equals))
            n += await enqueue(
              tx,
              "workflow_step",
              wfJob(w, tr.entity, r.record_id as string),
              now,
              `wf:${w.name}:a${r.id}`,
            );
        }
      }
      await writeCursor(tx, { ...cursor, audit: String(last.id) });
      return n;
    });

  /** schedule: relative (record.field + offset, not past at creation) and cron (latest occurrence). */
  const scheduleTriggers = () =>
    system(async (tx) => {
      const cursor = await readCursor(tx);
      const from = cursor.at ? new Date(cursor.at) : (o.since ?? now);
      let n = 0;
      for (const w of spec.workflows ?? []) {
        const tr = w.trigger;
        if (tr.type !== "schedule") continue;
        if (tr.entity && tr.relative?.field) {
          const f = quoteIdent(tr.relative.field);
          const due = `(${f})::timestamptz + make_interval(mins => $1::int)`;
          const rows = await tx.unsafe(
            `select id::text as id, ${due} as due from ${T(tr.entity)}
             where ${f} is not null and ${due} <= $2::timestamptz and ${due} >= created_at limit 1000`,
            [tr.relative.offsetMinutes ?? 0, now.toISOString()],
          );
          for (const r of rows) {
            const at = r.due instanceof Date ? r.due : new Date(String(r.due));
            n += await enqueue(
              tx,
              "workflow_step",
              wfJob(w, tr.entity, r.id as string),
              at,
              `wf:${w.name}:${r.id}:${at.toISOString()}`,
            );
          }
        } else if (tr.cron) {
          const c = parseCron(tr.cron);
          const at = c ? lastOccurrence(c, from, now, spec.app.timezone ?? DEFAULT_TIMEZONE) : null;
          if (at)
            n += await enqueue(tx, "workflow_step", wfJob(w), at, `wf:${w.name}:cron:${at.toISOString()}`);
        }
      }
      await writeCursor(tx, { ...cursor, at: now.toISOString() });
      return n;
    });

  // ---------- execution ----------

  /** Due jobs, leased (locked_until) in their own transaction so a concurrent runner skips them. */
  const claim = () =>
    system(async (tx) => {
      const rows = await tx.unsafe(
        `update ${T("_w_jobs")} set locked_until = now() + interval '${LEASE}'
         where id in (select id from ${T("_w_jobs")}
           where run_at <= $1::timestamptz and (locked_until is null or locked_until < now())
           and kind in ('function', 'workflow_step')
           order by run_at, id limit ${BATCH} for update skip locked)
         returning id::text as id, kind, payload, attempts, run_at`,
        [now.toISOString()],
      );
      const at = (r: Row) => (r.run_at instanceof Date ? r.run_at.getTime() : 0);
      const sorted = [...rows].sort((a, b) => at(a) - at(b) || String(a.id).localeCompare(String(b.id)));
      return sorted as unknown as JobRow[];
    });

  const finish = (id: string) =>
    system((tx) =>
      tx.unsafe(
        `update ${T("_w_jobs")} set locked_until = 'infinity',
         payload = payload || cast($2::text as jsonb) where id = $1::uuid`,
        [id, JSON.stringify({ state: "done" })],
      ),
    );

  const fail = (job: JobRow, f: Omit<JobFailure, "jobId" | "kind" | "dead">, payload: Row) =>
    system(async (tx) => {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await tx.unsafe(
        `update ${T("_w_jobs")} set attempts = $2, run_at = $3::timestamptz,
         locked_until = ${dead ? "'infinity'" : "null"}, payload = cast($4::text as jsonb) where id = $1::uuid`,
        [
          job.id,
          attempts,
          new Date(now.getTime() + backoffMs(attempts)).toISOString(),
          JSON.stringify({ ...payload, error: f.code, ...(dead ? { state: "dead" } : {}) }),
        ],
      );
      report.failed.push({ jobId: job.id, kind: job.kind as JobFailure["kind"], ...f, dead });
      services.log?.({
        ts: new Date().toISOString(),
        level: "error",
        msg: "job_failed",
        system: sys.entry.slug,
        env: sys.entry.env,
        job: f.name,
        step: f.step ?? null,
        code: f.code,
        attempts,
      });
    });

  const fns = () => {
    if (!services.env.unsafeLocalExec && !services.sandbox) throw new WizardError("FUNCTIONS_DISABLED");
    return systemFunctions(sys, services, services.log);
  };
  const connectors = () => outboxConnectors(spec, services);

  function record(entity: string, id: string): Promise<Row | null> {
    return sys.data.transaction("default", SYSTEM_SUBJECT, (d) => d.system.get(entity, id));
  }

  function subst(v: unknown, rec: Row | null): unknown {
    if (typeof v === "string") {
      if (v === "$now") return now.toISOString();
      const m = RECORD_REF_RE.exec(v);
      if (m) return rec?.[m[1] as string] ?? null;
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => subst(x, rec));
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, rec)]));
    return v;
  }

  /** {{field}} and {{ref.field}} of the record (runtime.yaml#workflows.step_params). */
  async function render(text: string, entity: Entity | undefined, rec: Row | null): Promise<string> {
    const parts: string[] = [];
    let at = 0;
    for (const m of text.matchAll(TEMPLATE_RE)) {
      const start = m.index ?? 0;
      parts.push(text.slice(at, start));
      at = start + m[0].length;
      let v: unknown = rec?.[m[1] as string];
      if (m[2] !== undefined) {
        const target = entity?.fields.find((f) => f.name === m[1])?.ref?.entity;
        const ref = target && typeof v === "string" && target !== "users" ? await record(target, v) : null;
        v = ref?.[m[2]];
      }
      parts.push(v === null || v === undefined ? "" : String(v));
    }
    parts.push(text.slice(at));
    return parts.join("");
  }

  function ifMatches(cond: unknown, rec: Row | null): boolean {
    if (cond === null || typeof cond !== "object") return true;
    return Object.entries(cond as Row).every(([k, allowed]) => {
      const v = rec?.[k];
      const list = Array.isArray(allowed) ? allowed : [allowed];
      return list.some((a) => String(a) === String(v));
    });
  }

  function integrationOf(name: unknown) {
    const list = spec.integrations ?? [];
    return list.find((i) => i.name === name) ?? list.find((i) => i.connector === name);
  }

  async function callAction(integration: string, action: string, input: unknown): Promise<unknown> {
    const fn = connectors()[integration]?.[action];
    if (!fn) throw new WizardError("NOT_FOUND", { message: "Действие коннектора не найдено" });
    return fn(input);
  }

  /** Runs the steps from payload.step; a wait step re-enqueues the rest. Throws StepFailure. */
  async function runWorkflow(job: JobRow, p: WorkflowPayload): Promise<void> {
    const w = (spec.workflows ?? []).find((x) => x.name === p.workflow);
    if (!w) return; // the workflow was removed from the spec
    const entity = spec.entities.find((e) => e.name === p.entity);
    for (let i = p.step ?? 0; i < w.steps.length; i++) {
      const step = w.steps[i] as Workflow["steps"][number];
      const params = (step.params ?? {}) as Row;
      try {
        const rec = p.entity && p.recordId ? await record(p.entity, p.recordId) : null;
        if (p.recordId && !rec) return; // the record is gone (deleted, retention)
        if (!ifMatches(params.if, rec)) continue;
        const key = `${job.id}:${i}`;
        switch (step.type) {
          case "function": {
            const { host } = await fns();
            await host.call(String(params.name), subst(params.args ?? {}, rec), {
              user: SYSTEM_USER,
              via: "internal",
            });
            break;
          }
          case "notify": {
            const integ = integrationOf(params.integration);
            if (!integ) throw new WizardError("NOT_FOUND", { message: "Интеграция не найдена" });
            const to = subst(params.to, rec);
            if (typeof to !== "string" || to === "") break; // no recipient on this record
            const live = services.connectors === "live" ? services.connectorHost : undefined;
            if (live && rec && p.entity) {
              // connectors: 'live' — the connector renders the template and sends (M1-06 runNotifyStep).
              try {
                await runNotifyStep(
                  live.ctx(sys, integ),
                  {
                    params,
                    entity: p.entity,
                    record: { ...rec, id: String(rec.id) },
                    jobId: job.id,
                    stepIndex: i,
                  },
                  { deadlineMs: 25_000 },
                );
              } catch (e) {
                if (isConnectorError(e)) throw new WizardError(e.code, { message: e.message });
                throw e;
              }
              break;
            }
            const text = typeof params.text === "string" ? await render(params.text, entity, rec) : undefined;
            const base = { userId: to, idempotencyKey: key };
            if (integ.connector === "telegram") await callAction(integ.name, "sendToUser", { ...base, text });
            else if (integ.connector === "email")
              await callAction(integ.name, "sendTemplate", {
                ...base,
                template: params.template ?? null,
                ...(text !== undefined ? { text } : {}),
                ...(params.attachQr === true ? { attachQr: true } : {}),
                ...(p.entity && p.recordId ? { entity: p.entity, recordId: p.recordId } : {}),
              });
            else throw new WizardError("VALIDATION_FAILED", { message: "Коннектор не шлёт уведомления" });
            break;
          }
          case "connector": {
            const integ = integrationOf(params.integration);
            if (!integ) throw new WizardError("NOT_FOUND", { message: "Интеграция не найдена" });
            const input = subst(params.input ?? {}, rec);
            await callAction(integ.name, String(params.action), {
              ...(input !== null && typeof input === "object" ? input : {}),
              idempotencyKey: key,
            });
            break;
          }
          case "update":
          case "create": {
            const target = typeof params.entity === "string" ? params.entity : p.entity;
            if (!target) throw new WizardError("VALIDATION_FAILED", { message: "Не указана сущность шага" });
            const set = (subst(params.set ?? {}, rec) ?? {}) as Row;
            const own = target === p.entity ? p.recordId : "";
            const id =
              step.type === "update" ? String(params.id !== undefined ? subst(params.id, rec) : own) : "";
            await sys.data.transaction("write", SYSTEM_SUBJECT, async (d) => {
              if (step.type === "create") await d.system.insert(target, set);
              else await d.system.patch(target, id, set);
            });
            break;
          }
          case "wait": {
            const minutes = Number(params.minutes ?? 0);
            await system((tx) =>
              enqueue(
                tx,
                "workflow_step",
                { ...p, step: i + 1 },
                new Date(now.getTime() + Math.max(0, minutes) * MINUTE),
                key,
              ),
            );
            return;
          }
          case "ai_extract":
          case "ai_generate": {
            // runtime.yaml#ai_actions.triggers: params {action}; the record of the workflow, call id = the step key, so
            // a retried step neither counts against the monthly limit nor charges twice (M3-02).
            const action = findAiAction(sys, String(params.action ?? ""));
            if (!p.recordId || action.entity.name !== p.entity)
              throw new WizardError("VALIDATION_FAILED", {
                message: "ИИ-действие относится к другому разделу",
              });
            if (action.kind !== (step.type === "ai_extract" ? "extract" : "generate"))
              throw new WizardError("VALIDATION_FAILED", { message: "Тип шага не совпадает с ИИ-действием" });
            await runAiAction(sys, services.ai, {
              action,
              recordId: p.recordId,
              callId: `wf:${key}`,
              source: "workflow",
            });
            break;
          }
          default:
            break;
        }
      } catch (e) {
        throw new StepFailure(i, step.type, errorCode(e));
      }
    }
  }

  async function execute(job: JobRow): Promise<void> {
    const payload = (job.payload ?? {}) as Row;
    if (job.kind === "function") {
      const name = String(payload.name ?? "");
      try {
        const { host } = await fns();
        await host.call(name, payload.args ?? {}, { user: SYSTEM_USER, via: "internal" });
      } catch (e) {
        await fail(job, { name, code: errorCode(e) }, payload);
        return;
      }
    } else {
      const p = payload as unknown as WorkflowPayload;
      try {
        await runWorkflow(job, p);
      } catch (e) {
        const f = e instanceof StepFailure ? e : new StepFailure(p.step ?? 0, "", errorCode(e));
        // Completed steps are not repeated: the retry resumes at the failed step.
        await fail(
          job,
          { name: p.workflow, step: f.step, stepType: f.stepType, code: f.code },
          { ...payload, step: f.step },
        );
        return;
      }
    }
    await finish(job.id);
    report.ran += 1;
  }

  // ---------- the pass ----------

  await scheduleTriggers();
  let rounds = o.maxRounds ?? 20;
  for (; rounds > 0; rounds--) {
    const triggered = await auditTriggers();
    const jobs = await claim();
    for (const job of jobs) await execute(job);
    if (triggered === 0 && jobs.length === 0) break;
  }
  const ret = await runRetention(sys, services, now);
  report.retention.push(...ret.retention);
  report.failed.push(...ret.failed);
  if (rounds === 0) {
    const [row] = await system((tx) =>
      tx.unsafe(
        `select count(*)::int as n from ${T("_w_jobs")} where run_at <= $1::timestamptz and locked_until is null`,
        [now.toISOString()],
      ),
    );
    report.pending = Number(row?.n ?? 0);
  }
  return report;
}

// ---------- retention ----------

/** _w_jobs row (like the cursor: kind workflow_step, run_at = locked_until = infinity, never claimed) marking the last retention pass {at, failed}. */
export const RETENTION_MARKER_KEY = "__wizard_retention";
/** _w_jobs row asking for a retention pass now (platform retention_cron watchdog, workflows.yaml#retention_cron). */
export const RETENTION_REQUEST_KEY = "__wizard_retention_request";
/** Daily slot of the pass: 03:00 MSK = 00:00 UTC (Moscow has no DST; runtime.yaml#workflows.retention). */
const RETENTION_SLOT_UTC_HOUR = 0;

export interface RetentionPassReport {
  retention: RetentionResult[];
  failed: JobFailure[];
}

/**
 * One retention pass of a system (runtime.yaml#workflows.retention): entities with retention, users without login for
 * 3 years, due consent withdrawals; then the pass marker is written and a pending request is consumed. A failing
 * entity is reported (and logged), never thrown.
 */
export async function runRetention(
  sys: LoadedSystem,
  services: RuntimeServices,
  now: Date,
): Promise<RetentionPassReport> {
  const spec = sys.spec;
  const S = quoteIdent(sys.schema);
  const T = (table: string) => `${S}.${quoteIdent(table)}`;
  const report: RetentionPassReport = { retention: [], failed: [] };
  const system = <R>(fn: (tx: Tx) => Promise<R>) =>
    sys.data.transaction("default", SYSTEM_SUBJECT, (d) => fn(d.sql));

  async function privacyPass(name: string, fn: () => Promise<void>, entity = name): Promise<void> {
    try {
      await fn();
    } catch (err) {
      services.log?.({
        ts: new Date().toISOString(),
        level: "error",
        msg: "retention_failed",
        system: sys.entry.slug,
        env: sys.entry.env,
        entity,
        sqlstate: (err as { code?: unknown }).code ?? null,
      });
      report.failed.push({ jobId: "", kind: "workflow_step", name, code: errorCode(err), dead: false });
    }
  }

  for (const e of spec.entities) {
    const r = e.retention;
    if (!r) continue;
    const mode = r.mode ?? "delete";
    const anchor = quoteIdent(r.anchorField ?? "created_at");
    const expires = `(${anchor})::timestamptz + make_interval(days => $1::int)`;
    const cond = `${anchor} is not null and ${expires} < $2::timestamptz`;
    const pii = piiFields(e);
    if (mode === "anonymize" && pii.length === 0) continue;
    // File fields cleared or deleted with their rows: objects go after the commit (runtime.yaml#files).
    const fileCols = e.fields
      .filter((f) => f.type === "file" && (mode === "delete" || pii.includes(f.name)))
      .map((f) => quoteIdent(f.name));
    await privacyPass(
      `retention:${e.name}`,
      async () => {
        const files: string[] = [];
        const collect = (rows: readonly Row[]) => {
          for (const row of rows)
            for (const v of Object.values(row)) if (typeof v === "string") files.push(v);
        };
        const rows = await system(async (tx) => {
          if (fileCols.length && mode === "anonymize")
            collect(
              await tx.unsafe(`select ${fileCols.join(", ")} from ${T(e.name)} where ${cond}`, [
                r.deleteAfterDays,
                now.toISOString(),
              ]),
            );
          const res =
            mode === "delete"
              ? await tx.unsafe(
                  `delete from ${T(e.name)} where ${cond}${fileCols.length ? ` returning ${fileCols.join(", ")}` : ""}`,
                  [r.deleteAfterDays, now.toISOString()],
                )
              : await tx.unsafe(
                  `update ${T(e.name)} set ${pii.map((f) => `${quoteIdent(f)} = null`).join(", ")}
                 where ${cond} and (${pii.map((f) => `${quoteIdent(f)} is not null`).join(" or ")})`,
                  [r.deleteAfterDays, now.toISOString()],
                );
          if (res.count > 0) {
            // runtime.yaml#workflows.retention: counter in _w_audit (field names, never values).
            await tx.unsafe(
              `insert into ${T("_w_audit")} (role, entity, op, fields)
             values ($1, $2, 'retention', string_to_array($3::text, ','))`,
              [SYSTEM_ROLE, e.name, mode === "anonymize" ? pii.join(",") : ""],
            );
            // Deletion journal: anchor values before the cutoff expired (compliance.yaml#retention.deletion_log).
            const cutoff = new Date(now.getTime() - r.deleteAfterDays * 86_400_000);
            await logDeletions(
              tx,
              sys.schema,
              [{ entity: e.name, mode, rows: res.count, cutoff, fields: mode === "anonymize" ? pii : [] }],
              now,
            );
          }
          if (mode === "delete" && fileCols.length) collect(res);
          return res.count;
        });
        // A storage failure leaves the objects unreferenced: the files sweep below (or the next pass) deletes them.
        if (files.length) await sys.files?.release(files).catch(() => 0);
        report.retention.push({ entity: e.name, mode, rows });
      },
      e.name,
    );
  }
  await privacyPass("retention:users", async () => {
    const u = await retainUsers(sys, now);
    if (u.rows > 0) report.retention.push({ entity: "users", mode: "anonymize", rows: u.rows });
  });
  await privacyPass("retention:consent_revoked", async () => {
    for (const d of await runDueErasures(sys, now))
      if (d.rows > 0) report.retention.push({ entity: d.entity, mode: "consent_revoked", rows: d.rows });
  });
  // Uploads never attached and files whose release failed earlier (runtime.yaml#files).
  if (sys.files) {
    const files = sys.files;
    await privacyPass("retention:files", async () => void (await files.sweep(now)), "files");
  }
  // The marker the platform watchdog reads (alert after 26 h without a pass); a pending request is now served.
  await privacyPass("retention:marker", () =>
    system(async (tx) => {
      await tx.unsafe(
        `insert into ${T("_w_jobs")} (kind, payload, run_at, locked_until, idempotency_key)
         values ('workflow_step', cast($1::text as jsonb), 'infinity', 'infinity', $2)
         on conflict (idempotency_key) do update set payload = excluded.payload`,
        [
          JSON.stringify({ state: "retention_pass", at: now.toISOString(), failed: report.failed.length }),
          RETENTION_MARKER_KEY,
        ],
      );
      await tx.unsafe(`delete from ${T("_w_jobs")} where idempotency_key = $1`, [RETENTION_REQUEST_KEY]);
    }),
  );
  return report;
}

/** The last daily slot at or before `now` (03:00 MSK). */
export function retentionSlot(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(RETENTION_SLOT_UTC_HOUR, 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** Whether a retention pass is due: no marker, the marker predates today's slot, or the platform asked for one. */
export async function retentionDue(sys: LoadedSystem, now: Date): Promise<boolean> {
  const T = (table: string) => `${quoteIdent(sys.schema)}.${quoteIdent(table)}`;
  const rows = await sys.data.transaction("default", SYSTEM_SUBJECT, (d) =>
    d.sql.unsafe(`select idempotency_key, payload from ${T("_w_jobs")} where idempotency_key in ($1, $2)`, [
      RETENTION_MARKER_KEY,
      RETENTION_REQUEST_KEY,
    ]),
  );
  if (rows.some((r) => r.idempotency_key === RETENTION_REQUEST_KEY)) return true;
  const at = Date.parse(String((rows[0]?.payload as Row | undefined)?.at ?? ""));
  return Number.isNaN(at) || at < retentionSlot(now).getTime();
}
