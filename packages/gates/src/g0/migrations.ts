// G0-MIG-01 (planMigration; in prod destructive changes only with the owner's confirmation, M2-72) and G0-MIG-02
// (DDL+RLS on a rolled-back shadow schema).
import {
  type AppSpec,
  archiveSchemaName,
  describeStep,
  destructiveChanges,
  planMigration,
  toDDL,
} from "@wizard/appspec";
import type postgres from "postgres";
import type { Finding } from "../report.js";

export interface MigrationCheckOptions {
  /**
   * M2-72 (gates.yaml#G0 G0-MIG-01): the platform checked the owner's confirmation of this revision against the
   * current list of consequences (platform.destructive_changes).
   */
  destructiveConfirmed?: boolean;
}

/**
 * Plan of prev → next for the gate: in prod a plan whose destructive steps touch no data (index, unique, FK drops)
 * needs no confirmation; one that removes or narrows data passes only with destructiveConfirmed.
 */
function gatePlan(prev: AppSpec | null, next: AppSpec, env: "draft" | "prod", confirmed: boolean) {
  const plan = planMigration(prev, next, { env });
  if (env !== "prod" || plan.additiveOnly) return { plan, needsConfirmation: false };
  const needsConfirmation = destructiveChanges(plan).length > 0;
  if (needsConfirmation && !confirmed) return { plan, needsConfirmation };
  return { plan: planMigration(prev, next, { env, destructiveConfirmed: true }), needsConfirmation };
}

export function checkMigrationPlan(
  prev: AppSpec | null,
  next: AppSpec,
  env: "draft" | "prod",
  opts: MigrationCheckOptions = {},
): Finding[] {
  const { plan, needsConfirmation } = gatePlan(prev, next, env, opts.destructiveConfirmed === true);
  const out: Finding[] = plan.errors
    .filter((e) => e.code !== "DESTRUCTIVE_IN_PROD")
    .map((e) => ({
      message_ru: e.message_ru,
      ...(e.path ? { path: e.path } : {}),
      evidence: e.code,
      fixHint: e.hint ?? "Исправьте описание системы",
    }));
  if (plan.errors.some((e) => e.code === "DESTRUCTIVE_IN_PROD") && needsConfirmation) {
    out.push({
      message_ru: "Правка удаляет или сужает данные работающей системы и ждёт подтверждения владельца",
      evidence: `DESTRUCTIVE_IN_PROD: ${plan.destructive.map(describeStep).join("; ")}`,
      fixHint:
        "Владелец смотрит последствия и подтверждает правку в кабинете; данные уйдут в архив, правку можно отменить",
    });
  }
  return out;
}

const SYSTEM_KEY_RE = /^[a-z0-9][a-z0-9_]{0,40}$/;
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
  opts: MigrationCheckOptions = {},
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
  const { plan } = gatePlan(base, next, base ? env : "draft", opts.destructiveConfirmed === true);
  // A confirmed prod plan archives what it removes (M2-72): the shadow archive goes with the rollback.
  statements.push(...toDDL(plan, schema, { archive: { schema: archiveSchemaName(schema), tag: "shadow" } }));
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
