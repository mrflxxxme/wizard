// G0-MIG-01 (planMigration, additive-only in prod) and G0-MIG-02 (DDL+RLS on a rolled-back shadow schema).
import { type AppSpec, describeStep, planMigration, toDDL } from "@wizard/appspec";
import type postgres from "postgres";
import type { Finding } from "../report.js";

export function checkMigrationPlan(prev: AppSpec | null, next: AppSpec, env: "draft" | "prod"): Finding[] {
  const plan = planMigration(prev, next, { env });
  const out: Finding[] = plan.errors.map((e) => ({
    message_ru: e.message_ru,
    ...(e.path ? { path: e.path } : {}),
    evidence: e.code,
    fixHint: e.hint ?? "Исправьте описание системы",
  }));
  if (env === "prod" && !plan.additiveOnly && !out.some((f) => f.evidence === "DESTRUCTIVE_IN_PROD")) {
    for (const s of plan.destructive) {
      out.push({
        message_ru: `Шаг миграции «${describeStep(s)}» разрушает данные и запрещён в prod`,
        evidence: "DESTRUCTIVE_IN_PROD",
        fixHint: "В prod разрешены только аддитивные изменения",
      });
    }
  }
  return out;
}

const SYSTEM_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;
const ROLLBACK = Symbol("rollback");

export function shadowSchema(systemKey: string): string {
  if (!SYSTEM_KEY_RE.test(systemKey)) throw new Error(`invalid systemKey for a shadow schema: ${systemKey}`);
  return `app_${systemKey}_shadow`;
}

/** Applies the whole chain (prev from scratch, then prev → next) in one transaction and always rolls back. */
export async function checkShadowApply(
  db: postgres.Sql,
  systemKey: string,
  prev: AppSpec | null,
  next: AppSpec,
  env: "draft" | "prod",
): Promise<Finding[]> {
  const schema = shadowSchema(systemKey);
  const statements: string[] = [];
  let base: AppSpec | null = null;
  if (prev) {
    try {
      statements.push(...toDDL(planMigration(null, prev, { env: "draft" }), schema));
      base = prev;
    } catch {
      base = null; // previous revision no longer valid under current rules: apply `next` from scratch
    }
  }
  statements.push(...toDDL(planMigration(base, next, { env: base ? env : "draft" }), schema));
  let failure: Finding | null = null;
  try {
    await db.begin(async (tx) => {
      for (const s of statements) {
        try {
          await tx.unsafe(s);
        } catch (e) {
          const err = e as { message?: string; code?: string };
          failure = {
            message_ru: "Структура данных не применяется к базе",
            evidence: `${err.code ?? ""} ${err.message ?? String(e)}`.trim(),
            fixHint: "Проверьте типы полей, ссылки и права в описании системы",
          };
          throw ROLLBACK;
        }
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return failure ? [failure] : [];
}
