// The whole model chain refused a call (LlmError LLM_UNAVAILABLE, agents/models.yaml#fallback_rules): the specialist
// sees why in the run journal (internal event models_unavailable, workflows.yaml#events.types), the founder gets one
// alert per hour (db.yaml#ops_alerts), the client gets plain text (MODELS_UNAVAILABLE_RU) — never model names.
import type { ProviderDegraded } from "@wizard/llm";
import { sql } from "kysely";
import { moscowDay, PROVIDER_LABELS } from "../billing/llm-cap.js";
import type { Db } from "../db/index.js";
import { alertOnce, type OpsAlertFn } from "../ops/alert.js";

/** run_failed message_ru of LLM_UNAVAILABLE (D28, D48: plain language, no model names). */
export const MODELS_UNAVAILABLE_RU =
  "Сейчас не получается продолжить: сервис, который пишет систему, не отвечает. Команда уже знает об этом. Попробуйте ещё раз через несколько минут или напишите команде.";

export interface ModelAttempt {
  model: string;
  tier: string;
  status: string;
  errorCode: string | null;
  count: number;
}

/** Failed attempts of `runId` (of `callType` when given), grouped by model and error, at most 20 rows. */
export async function failedAttempts(
  db: Db,
  runId: string,
  callType: string | null,
): Promise<ModelAttempt[]> {
  let q = db
    .selectFrom("platform.llm_calls")
    .select(["model_id", "tier", "status", "error_code", sql<number>`count(*)::int`.as("n")])
    .where("run_id", "=", runId)
    .where("status", "<>", "ok");
  if (callType) q = q.where("call_type", "=", callType);
  const rows = await q
    .groupBy(["model_id", "tier", "status", "error_code"])
    .orderBy("model_id")
    .limit(20)
    .execute();
  return rows.map((r) => ({
    model: r.model_id,
    tier: r.tier,
    status: r.status,
    errorCode: r.error_code,
    count: Number(r.n),
  }));
}

/** One line for the founder: «glm-5.3 (T1): timeout ×3; qwen (T0): error HTTP_503 ×1». */
export function attemptsLine(attempts: ModelAttempt[]): string {
  if (attempts.length === 0)
    return "ни одной попытки вызова: у моделей цепочки нет ключей (NO_API_KEY) или все они отключены";
  return attempts
    .map((a) => `${a.model} (${a.tier}): ${a.status}${a.errorCode ? ` ${a.errorCode}` : ""} ×${a.count}`)
    .join("; ");
}

export interface ModelsOutageInput {
  db: Db;
  run: { id: string; kind: string; system_id: string | null; org_id: string };
  callType: string | null;
  emit(payload: Record<string, unknown>): Promise<void>;
  alert?: OpsAlertFn | undefined;
  now?: Date;
}

/** Writes models_unavailable into the run journal and alerts the founder (once per hour across replicas). */
export async function reportModelsUnavailable(i: ModelsOutageInput): Promise<ModelAttempt[]> {
  const attempts = await failedAttempts(i.db, i.run.id, i.callType);
  await i.emit({ callType: i.callType ?? "", attempts });
  const hour = (i.now ?? new Date()).toISOString().slice(0, 13);
  await alertOnce(i.db, `llm_chain_failed:${hour}`, i.alert, {
    level: "error",
    event: "llm_chain_failed",
    text:
      `Wizard: вся цепочка моделей отказала (вызов ${i.callType ?? "?"}) — прогон ${i.run.id} (${i.run.kind}), ` +
      `система ${i.run.system_id ?? "—"}, организация ${i.run.org_id}. Попытки: ${attemptsLine(attempts)}. ` +
      "Клиент видит просьбу повторить позже. Проверьте ключи и доступность провайдеров; следующие отказы этого часа — в журнале прогонов (models_unavailable).",
    fields: { code: "LLM_UNAVAILABLE", reason: i.callType ?? null, count: attempts.length },
  });
  return attempts;
}

export interface ProviderDegradedInput {
  db: Db;
  event: ProviderDegraded;
  alert?: OpsAlertFn | undefined;
  now?: Date;
}

/**
 * @wizard/llm onProviderDegraded (D76, models.yaml#fallback_rules): an empty balance alerts the founder once per Moscow
 * day and provider, an opened model breaker once per hour and model (db.yaml#ops_alerts). No run or prompt data.
 */
export async function reportProviderDegraded(i: ProviderDegradedInput): Promise<boolean> {
  const now = i.now ?? new Date();
  const { provider, reason } = i.event;
  const label = PROVIDER_LABELS[provider] ?? provider;
  if (reason === "balance_exhausted") {
    const reserve =
      provider === "zai"
        ? "Сборки идут на моделях в РФ (Cloud.ru)."
        : "Вызовы идут на запасные модели; если запасных нет, клиент видит просьбу повторить позже.";
    return alertOnce(i.db, `llm_provider_balance:${provider}:${moscowDay(now).key}`, i.alert, {
      level: "error",
      event: "llm_provider_balance_exhausted",
      text:
        `Wizard: у провайдера моделей ${label} закончился баланс. Вызовы к нему остановлены на 30 минут без повторов. ` +
        `${reserve} Пополните баланс — после пополнения вызовы вернутся к нему сами в течение 30 минут.`,
      fields: { code: "PROVIDER_BALANCE_EXHAUSTED", reason: provider },
    });
  }
  const model = i.event.model ?? "?";
  return alertOnce(
    i.db,
    `llm_provider_circuit:${provider}:${model}:${now.toISOString().slice(0, 13)}`,
    i.alert,
    {
      level: "warn",
      event: "llm_provider_circuit_open",
      text:
        `Wizard: модель ${model} провайдера ${label} не отвечает (ошибки подряд) — вызовы временно идут на запасные модели. ` +
        "Следующие отключения этой модели в этот час не присылаются.",
      fields: { code: "LLM_CIRCUIT_OPEN", reason: `${provider}:${model}` },
    },
  );
}
