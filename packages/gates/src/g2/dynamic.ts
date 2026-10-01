// G2-PERM-01…04 against a running runtime (gates.yaml#G2): the full role × entity × op matrix through the data API
// and directly in SQL under RLS, row isolation and hidden fields — also through public functions (minimal args) —
// and ПДн read via ctx.systemDb that the caller's role cannot see (sdk.md §2.3, L3-22).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppSpec,
  type Entity,
  PERMISSION_OPS,
  type PermissionOp,
  quoteIdent,
  USERS_ENTITY,
} from "@wizard/appspec";
import { buildSystem, writeArtifact } from "@wizard/build";
import type postgres from "postgres";
import { generatePermissionChecks } from "../g1/checks.js";
import { type Actor, G1Env } from "../g1/env.js";
import { minimalArgs } from "../g1/fnargs.js";
import { Prober } from "../g1/probes.js";
import { g1SeedKey, seedActors } from "../g1/run.js";
import { fieldPiiCategory, generateSeed, seedDlp, ValueGen } from "../g1/seed.js";
import type { QaCheck, Seed } from "../g1/types.js";
import type { CheckOutcome, Finding } from "../report.js";
import type { GateContext } from "../types.js";

export const DYNAMIC_CHECKS = ["G2-PERM-01", "G2-PERM-02", "G2-PERM-03", "G2-PERM-04"] as const;
export type DynamicId = (typeof DYNAMIC_CHECKS)[number];

export interface DynamicOptions {
  deps?: { buildSystem?: typeof buildSystem };
  /** Test hook: runs after DDL+RLS on the ephemeral schema (e.g. a tampered policy for a negative fixture). */
  afterMigrate?: (db: postgres.Sql, schema: string) => Promise<void>;
  /** Test hook: the revision the runtime serves, when it differs from ctx.spec (drift between spec and runtime). */
  runtimeSpec?: AppSpec;
}

type Outcomes = Record<DynamicId, CheckOutcome>;

const OP_RU: Record<PermissionOp, string> = {
  read: "чтение",
  create: "создание",
  update: "изменение",
  delete: "удаление",
};

class SetupError extends Error {
  constructor(
    message: string,
    readonly evidence?: string,
  ) {
    super(message);
  }
}

export async function runDynamic(
  ctx: GateContext,
  opts: DynamicOptions,
  timeLeft: () => boolean,
): Promise<Outcomes> {
  const all = (o: CheckOutcome): Outcomes =>
    Object.fromEntries(DYNAMIC_CHECKS.map((id) => [id, o])) as Outcomes;
  if (!ctx.runtime) return all({ kind: "error", reason_ru: "нет запущенного runtime для проверки прав" });
  if (!ctx.db) return all({ kind: "error", reason_ru: "нет подключения к базе данных" });
  const spec = ctx.spec;
  const now = ctx.now ?? new Date();
  const runId = randomBytes(4).toString("hex");
  const env = new G1Env(
    ctx.db,
    ctx.runtime,
    spec,
    ctx.systemKey,
    runId,
    ctx.runtimeRole ?? "wizard_runtime",
    "g2",
  );
  const artifacts = mkdtempSync(join(tmpdir(), "wz-g2-"));
  const out = all({ kind: "error", reason_ru: "не запускалась" });
  try {
    await env.migrate();
    if (opts.afterMigrate) await opts.afterMigrate(ctx.db, env.schema);
    let artifactDir: string | null = null;
    if ((spec.functions ?? []).length > 0) {
      const built = await (opts.deps?.buildSystem ?? buildSystem)({ spec, files: ctx.files, env: "draft" });
      if (!built.ok)
        throw new SetupError("система не собирается", built.errors.map((e) => e.message_ru).join("; "));
      artifactDir = writeArtifact(artifacts, randomBytes(6).toString("hex"), 1, built).dir;
    }
    await env.load(artifactDir, opts.runtimeSpec ?? spec);
    const seed = generateSeed(spec, g1SeedKey(ctx.systemKey, ctx.specVersion), { now });
    const dlp = seedDlp(spec, seed);
    if (dlp.length) throw new SetupError("начальные данные похожи на персональные (SEED_PII)");
    const spec0 = (await env.request(env.anonymous(), "GET", "/_wizard/spec")).body as {
      compliance?: { policyVersion?: string; consentTextHash?: string };
    } | null;
    const consent =
      spec0?.compliance?.policyVersion && spec0.compliance.consentTextHash
        ? { policyVersion: spec0.compliance.policyVersion, textHash: spec0.compliance.consentTextHash }
        : null;
    await env.reset(seed);
    const actors = await seedActors(env, spec, seed);
    const prober = new Prober(env, { seed, gen: new ValueGen(now, 200_000), consent, actors });
    const matrix = generatePermissionChecks(spec);
    const budget = (): CheckOutcome | null =>
      timeLeft() ? null : { kind: "error", reason_ru: "превышено время G2 (300 с)" };

    out["G2-PERM-01"] =
      budget() ??
      (await probeAll(
        prober,
        matrix.filter((c) => c.probe?.kind === "op"),
        timeLeft,
      ));
    out["G2-PERM-02"] = budget() ?? (await sqlMatrix(env, prober, spec, seed, actors, timeLeft));
    const fn = budget()
      ? null
      : await functionProbes(env, prober, spec, ctx.files, seed, actors, now, timeLeft);
    const rows =
      budget() ??
      (await probeAll(
        prober,
        matrix.filter((c) => c.probe?.kind === "row"),
        timeLeft,
      ));
    out["G2-PERM-03"] = merge(rows, fn?.rows);
    const hidden =
      budget() ??
      (await probeAll(
        prober,
        matrix.filter((c) => c.probe?.kind === "hidden"),
        timeLeft,
      ));
    out["G2-PERM-04"] = merge(hidden, fn?.hidden);
  } catch (e) {
    const reason = e instanceof SetupError ? e.message : "не удалось подготовить окружение проверки";
    const evidence = e instanceof SetupError ? e.evidence : String((e as Error)?.message ?? e);
    return all({ kind: "error", reason_ru: reason, ...(evidence ? { evidence } : {}) });
  } finally {
    await env.drop().catch(() => {});
    rmSync(artifacts, { recursive: true, force: true });
  }
  return out;
}

function merge(a: CheckOutcome, extra: Finding[] | undefined): CheckOutcome {
  if (a.kind !== "findings" || !extra) return a;
  return { kind: "findings", findings: [...a.findings, ...extra] };
}

async function probeAll(prober: Prober, checks: QaCheck[], timeLeft: () => boolean): Promise<CheckOutcome> {
  const findings: Finding[] = [];
  for (const c of checks) {
    if (!timeLeft()) return { kind: "error", reason_ru: "превышено время G2 (300 с)" };
    try {
      const r = await prober.run(c);
      if (r.status === "pass") continue;
      findings.push({
        status: r.status === "error" ? "error" : "fail",
        message_ru: r.message_ru,
        ...(r.path ? { path: r.path } : {}),
        evidence: `${c.id}${r.evidence ? `: ${r.evidence}` : ""}`,
        ...(r.fixHint ? { fixHint: r.fixHint } : {}),
      });
    } catch (e) {
      findings.push({
        status: "error",
        message_ru: `Не удалось проверить ${c.id}`,
        evidence: String((e as Error).message),
      });
    }
  }
  return { kind: "findings", findings };
}

/** wizard.user_attrs of a seed user (runtime: users row without id/role/attrs). */
function attrsOf(seed: Seed, id: string | null): Record<string, unknown> {
  const u = seed.users.find((x) => x.id === id);
  if (!u) return {};
  const { id: _id, role: _role, ...rest } = u;
  return rest;
}

/** G2-PERM-02: each (role, entity, op) straight in SQL under RLS as the runtime role, rolled back. */
async function sqlMatrix(
  env: G1Env,
  prober: Prober,
  spec: AppSpec,
  seed: Seed,
  actors: Map<string, Actor[]>,
  timeLeft: () => boolean,
): Promise<CheckOutcome> {
  const findings: Finding[] = [];
  const s = quoteIdent(env.schema);
  for (const r of spec.roles) {
    const a = actors.get(r.name)?.[0];
    if (!a) continue;
    const subject = { role: r.name, id: a.id, attrs: attrsOf(seed, a.id) };
    for (const [ei, e] of spec.entities.entries()) {
      const p = spec.permissions.find((x) => x.role === r.name && x.entity === e.name);
      const pi = spec.permissions.findIndex((x) => x.role === r.name && x.entity === e.name);
      const ops: readonly string[] = p?.ops ?? [];
      const t = `${s}.${quoteIdent(e.name)}`;
      for (const op of PERMISSION_OPS) {
        if (!timeLeft()) return { kind: "error", reason_ru: "превышено время G2 (300 с)" };
        let got: "allow" | "deny";
        try {
          got = await sqlProbe(env, prober, e, r.name, a, subject, t, op, ops.includes("read"));
        } catch (err) {
          findings.push({
            status: "error",
            message_ru: `Не удалось проверить политику ${OP_RU[op]} «${e.label}» для роли «${r.label}»`,
            evidence: `SQL: ${String((err as { code?: string }).code ?? "")} ${String((err as Error).message).slice(0, 200)}`,
          });
          continue;
        }
        const want = ops.includes(op) ? "allow" : "deny";
        if (got === want) continue;
        findings.push({
          message_ru:
            want === "deny"
              ? `База данных разрешает роли «${r.label}» ${OP_RU[op]} «${e.label}», хотя права это запрещают`
              : `База данных не даёт роли «${r.label}» ${OP_RU[op]} «${e.label}», хотя права это разрешают`,
          path: pi >= 0 ? `/permissions/${pi}` : `/entities/${ei}`,
          evidence: `RLS ${op}: ожидалось ${want}, получено ${got}`,
          fixHint: "Политики строк должны совпадать с правами спеки — пересоздайте RLS (toRLS) для схемы",
        });
      }
    }
  }
  return { kind: "findings", findings };
}

async function sqlProbe(
  env: G1Env,
  prober: Prober,
  e: Entity,
  role: string,
  actor: Actor,
  subject: { role: string; id: string | null; attrs: Record<string, unknown> },
  table: string,
  op: PermissionOp,
  canRead: boolean,
): Promise<"allow" | "deny"> {
  if (op === "create") {
    const row = await prober.buildRow(e, role, actor);
    return env.rolledBack(subject, async (tx) => {
      try {
        await env.insert(tx, e.name, row);
        return "allow";
      } catch (err) {
        if ((err as { code?: string }).code === "42501") return "deny";
        if (/^23/.test(String((err as { code?: string }).code))) return "allow"; // constraint after the RLS check
        throw err;
      }
    });
  }
  const id = await prober.freshRow(e, role, actor);
  return env.rolledBack(subject, async (tx) => {
    try {
      // UPDATE/DELETE with WHERE also need the SELECT policy (Postgres); without read they run unqualified.
      const where = op === "read" || canRead ? " where id = $1" : "";
      const params = where ? [id] : [];
      const sql =
        op === "read"
          ? `select count(*)::int as n from ${table}${where}`
          : op === "update"
            ? `update ${table} set id = id${where}`
            : `delete from ${table}${where}`;
      const res = await tx.unsafe(sql, params as never[]);
      const n = op === "read" ? Number((res[0] as { n?: number } | undefined)?.n ?? 0) : res.count;
      return n > 0 ? "allow" : "deny";
    } catch (err) {
      if ((err as { code?: string }).code === "23503") return "allow"; // FK restrict after the RLS check
      throw err;
    }
  });
}

/** Distinctive values of a row: strings ≥ 6 characters outside refs, enums, dates and ids. */
function distinctive(e: Entity, row: Record<string, unknown>, only?: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of e.fields) {
    if (["ref", "enum", "date", "datetime", "bool"].includes(f.type)) continue;
    if (only && !only(f.name)) continue;
    const v = row[f.name];
    if ((typeof v === "string" && v.length >= 6) || (typeof v === "number" && String(v).length >= 6))
      out.push(String(v));
  }
  return out;
}

/** PERM-03/04 through public queries: B's rows, hidden fields and invisible ПДн never come back to A. */
async function functionProbes(
  env: G1Env,
  prober: Prober,
  spec: AppSpec,
  files: ReadonlyMap<string, string>,
  seed: Seed,
  actors: Map<string, Actor[]>,
  now: Date,
  timeLeft: () => boolean,
): Promise<{ rows: Finding[]; hidden: Finding[] }> {
  const rows: Finding[] = [];
  const hidden: Finding[] = [];
  const perm = (role: string, entity: string) =>
    spec.permissions.find((p) => p.role === role && p.entity === entity);
  for (const [fi, f] of (spec.functions ?? []).entries()) {
    if (f.kind !== "query" || f.public !== true) continue;
    const source = files.get(f.file);
    if (!source) continue;
    for (const role of f.roles ?? []) {
      if (!timeLeft()) return { rows, hidden };
      const [a, b] = actors.get(role) ?? [];
      if (!a) continue;
      const call = async (idOf: (entity: string) => string | null) => {
        const args = minimalArgs(f.file, source, { now, idOf }) ?? {};
        const res = await env.raw(
          a,
          "POST",
          `/api/fn/${encodeURIComponent(f.name)}`,
          JSON.stringify({ args }),
        );
        return res.status < 300 ? res.text : "";
      };
      const seedId = (entity: string) =>
        entity === USERS_ENTITY ? a.id : ((seed.rows[entity]?.[0]?.id as string | undefined) ?? null);
      const where = { path: `/functions/${fi}`, file: f.file };

      // PERM-03: rows of B in entities where the role is row-filtered.
      for (const e of spec.entities) {
        const p = perm(role, e.name);
        if (!b || !p?.rowFilter || Object.keys(p.rowFilter).length === 0) continue;
        const row = await prober.buildRow(e, role, b);
        const idOf = (entity: string) => (entity === e.name ? (row.id as string) : seedId(entity));
        // Values A already gets without B's row (dictionary collisions of synthetic data) prove nothing.
        const before = await call(idOf);
        await env.insertRow(e.name, row);
        const body = await call(idOf);
        const leaked = distinctive(e, row).filter((v) => body.includes(v) && !before.includes(v));
        if (leaked.length)
          rows.push({
            message_ru: `Функция «${f.name}» показывает роли «${role}» чужие записи «${e.label}»`,
            ...where,
            evidence: `пользователь A получил ${leaked.length} знач. из записи пользователя B`,
            fixHint: "Читайте данные через ctx.db (права вызывающего), а не ctx.systemDb",
          });
      }

      // PERM-04: hidden fields of rows the role can read, and ПДн it cannot see (seed + fresh rows).
      const secrets: { entity: string; field: string; value: string; hidden: boolean }[] = [];
      for (const e of spec.entities) {
        const p = perm(role, e.name);
        const readable = p?.ops.includes("read") === true;
        const filtered = !!p?.rowFilter && Object.keys(p.rowFilter).length > 0;
        const hiddenSet = new Set(p?.hiddenFields ?? []);
        if (readable && hiddenSet.size) {
          const row = await prober.buildRow(e, role, a);
          const idOf = (entity: string) => (entity === e.name ? (row.id as string) : seedId(entity));
          const before = await call(idOf);
          await env.insertRow(e.name, row);
          const body = await call(idOf);
          const shown = e.fields.filter(
            (x) =>
              hiddenSet.has(x.name) &&
              distinctive(e, row, (n) => n === x.name).some((v) => body.includes(v) && !before.includes(v)),
          );
          if (shown.length)
            hidden.push({
              message_ru: `Функция «${f.name}» показывает роли «${role}» скрытые поля «${e.label}»`,
              ...where,
              evidence: `скрытые поля в ответе: ${shown.map((x) => x.name).join(", ")}`,
              fixHint: "Не возвращайте поля из hiddenFields роли; читайте через ctx.db",
            });
        }
        for (const fld of e.fields) {
          if (fieldPiiCategory(fld) === "none") continue;
          const invisibleField = !readable || hiddenSet.has(fld.name);
          const visible = new Set<unknown>();
          const candidates: string[] = [];
          for (const r of seed.rows[e.name] ?? []) {
            const mine = filtered && Object.values(r).includes(a.id);
            const v = r[fld.name];
            if (!invisibleField && (!filtered || mine)) visible.add(v);
            else if (typeof v === "string" && v.length >= 6) candidates.push(v);
          }
          for (const v of candidates)
            if (!visible.has(v))
              secrets.push({ entity: e.name, field: fld.name, value: v, hidden: invisibleField });
        }
      }
      if (secrets.length) {
        const body = await call(seedId);
        const leaked = secrets.filter((s) => body.includes(s.value));
        if (leaked.length)
          hidden.push({
            message_ru: `Функция «${f.name}» возвращает роли «${role}» персональные данные, которые этой роли не видны`,
            ...where,
            evidence: `поля: ${[...new Set(leaked.map((s) => `${s.entity}.${s.field}`))].join(", ")}`,
            fixHint:
              "Не возвращайте ПДн из ctx.systemDb; runtime должен вырезать такие поля из ответа /api/fn",
          });
      }
    }
  }
  return { rows, hidden };
}
