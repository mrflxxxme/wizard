// beta_readiness flag (backlog M2-09 acceptance; compliance.yaml#beta_readiness, milestones.yaml#M2.exit_criteria,
// D24_pilot_free): partner invitations go out only after M2-13 is done — the lawyer's templates and the RKN
// notification are founder actions, so the founder records them with `pilot readiness on` (db.yaml#platform_settings,
// who/when). The pilot CLI refuses `invite` until then.
import { userInfo } from "node:os";
import type { Db } from "../db/index.js";
import { json } from "../db/index.js";

export const BETA_READINESS_KEY = "beta_readiness";

export interface BetaReadiness {
  on: boolean;
  /** Who switched it (CLI --by or the OS user), null — never set. */
  by: string | null;
  at: Date | null;
  note: string | null;
}

/** Russian refusal of `pilot invite` while beta_readiness is off (what is missing and how to switch it on). */
export const BETA_READINESS_MISSING_RU = [
  "Приглашать партнёров пока нельзя: не отмечена готовность беты (beta_readiness, задача M2-13).",
  "До первого реального пользователя нужно: (1) подать уведомление в Роскомнадзор об обработке ПДн (ст. 22 152-ФЗ);",
  "(2) получить от юриста оферту, согласие на обработку ПДн и шаблон политики систем (без пометки DRAFT) и исполнить его позицию по хостингу и ОРИ;",
  "(3) подписать поручения на обработку с Cloud.ru и Yandex; (4) получить письменное подтверждение Z.ai или отключить T1;",
  "(5) подготовить документы в docs/security (модель угроз, акт УЗ, перечень допущенных, runbook инцидента с ПДн).",
  "Когда всё сделано, отметьте: pilot readiness on --by <кто> [--note <что сделано>].",
].join("\n");

const defaultActor = (): string => {
  try {
    return userInfo().username || "cli";
  } catch {
    return "cli";
  }
};

export async function getBetaReadiness(db: Db): Promise<BetaReadiness> {
  const row = await db
    .selectFrom("platform.platform_settings")
    .select(["value", "updated_by", "updated_at"])
    .where("key", "=", BETA_READINESS_KEY)
    .executeTakeFirst();
  if (!row) return { on: false, by: null, at: null, note: null };
  const v = (row.value ?? {}) as { on?: unknown; note?: unknown };
  return {
    on: v.on === true,
    by: row.updated_by,
    at: new Date(row.updated_at),
    note: typeof v.note === "string" ? v.note : null,
  };
}

/** Upserts the flag with who/when (the previous value is overwritten; the CLI prints the change). */
export async function setBetaReadiness(
  db: Db,
  a: { on: boolean; by?: string | null; note?: string | null; now?: Date },
): Promise<BetaReadiness> {
  const by = (a.by?.trim() || defaultActor()).slice(0, 120);
  const note = a.note?.trim().slice(0, 500) || null;
  const at = a.now ?? new Date();
  const value = { on: a.on, ...(note ? { note } : {}) };
  await db
    .insertInto("platform.platform_settings")
    .values({ key: BETA_READINESS_KEY, value: json(value), updated_by: by, updated_at: at })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: json(value), updated_by: by, updated_at: at }))
    .execute();
  return { on: a.on, by, at, note };
}
