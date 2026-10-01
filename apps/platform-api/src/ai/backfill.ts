// One-time backfill of old records by an AI action (runtime.yaml#ai_actions.triggers «разовый backfill старых записей
// — по флагу из change-карточки», M3-02). The approved change card lists action names in `aiBackfill`; the build
// requests a backfill for draft and prod (db.yaml#ai_backfills). The draft one runs at the end of that build; the prod
// one after the switch of the next publication whose spec has the action. The runtime walks the records (internal
// port, POST /_wizard/internal/ai-backfill) and calls the AI gateway per record, so the monthly limit, the credits and
// the platform cap apply as for a button; it stops at the first refusal.
import type { AppSpec } from "@wizard/appspec";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";

export interface BackfillResult {
  filled: number;
  skipped: number;
  /** Why the walk stopped early: AI_LIMIT_REACHED | AI_CREDITS_EXHAUSTED | AI_UNAVAILABLE | RUNTIME_UNREACHABLE. */
  stopCode: string | null;
}

/** Runtime side of a backfill (the internal port of the runtime). */
export type RuntimeAiBackfill = (req: {
  systemKey: string;
  env: "draft" | "prod";
  action: string;
  backfillId: string;
}) => Promise<BackfillResult>;

/** Backfill over HTTP: WIZARD_RUNTIME_INTERNAL_URL + WIZARD_INTERNAL_TOKEN; null when either is missing. */
export function httpRuntimeBackfill(
  config: Pick<Config, "runtimeInternalUrl" | "internalToken">,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): RuntimeAiBackfill | null {
  const { runtimeInternalUrl: base, internalToken: token } = config;
  if (!base || !token) return null;
  return async (req) => {
    let res: Response;
    try {
      res = await fetchImpl(new URL("/_wizard/internal/ai-backfill", base), {
        method: "POST",
        headers: { "content-type": "application/json", "x-wizard-internal-token": token },
        body: JSON.stringify({
          systemId: req.systemKey,
          env: req.env,
          action: req.action,
          backfillId: req.backfillId,
        }),
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      return { filled: 0, skipped: 0, stopCode: "RUNTIME_UNREACHABLE" };
    }
    const body = (await res.json().catch(() => null)) as Partial<BackfillResult> | null;
    if (!res.ok || !body) return { filled: 0, skipped: 0, stopCode: "RUNTIME_UNREACHABLE" };
    return {
      filled: Number(body.filled ?? 0),
      skipped: Number(body.skipped ?? 0),
      stopCode: typeof body.stopCode === "string" ? body.stopCode : null,
    };
  };
}

/** Names of card.aiBackfill that are AI actions of `spec` (unknown names are ignored). */
export function backfillActions(card: Record<string, unknown> | null | undefined, spec: AppSpec): string[] {
  const raw = card?.aiBackfill;
  if (!Array.isArray(raw)) return [];
  const names = new Set((spec.aiActions ?? []).map((a) => a.name));
  return [...new Set(raw.filter((x): x is string => typeof x === "string" && names.has(x)))];
}

/** A change build requests the backfill of `actions` in both environments (one pending row per env and action). */
export async function requestBackfills(
  db: Db,
  r: { systemId: string; runId: string; actions: readonly string[] },
): Promise<void> {
  if (r.actions.length === 0) return;
  await db
    .insertInto("platform.ai_backfills")
    .values(
      r.actions.flatMap((action) =>
        (["draft", "prod"] as const).map((env) => ({ system_id: r.systemId, env, action, run_id: r.runId })),
      ),
    )
    .onConflict((oc) =>
      oc.columns(["system_id", "env", "action"]).where("status", "=", "pending").doNothing(),
    )
    .execute();
}

/** Runs the pending backfills of `env` whose action exists in `spec`; each row ends done or failed (with stopCode). */
export async function runPendingBackfills(
  db: Db,
  i: {
    systemId: string;
    systemKey: string;
    env: "draft" | "prod";
    spec: AppSpec;
    runtime: RuntimeAiBackfill | null;
    now?: () => Date;
  },
): Promise<(BackfillResult & { action: string })[]> {
  const names = new Set((i.spec.aiActions ?? []).map((a) => a.name));
  const rows = await db
    .selectFrom("platform.ai_backfills")
    .select(["id", "action"])
    .where("system_id", "=", i.systemId)
    .where("env", "=", i.env)
    .where("status", "=", "pending")
    .orderBy("created_at")
    .execute();
  const out: (BackfillResult & { action: string })[] = [];
  for (const row of rows.filter((r) => names.has(r.action))) {
    const res = i.runtime
      ? await i.runtime({ systemKey: i.systemKey, env: i.env, action: row.action, backfillId: row.id })
      : { filled: 0, skipped: 0, stopCode: "RUNTIME_UNREACHABLE" };
    await db
      .updateTable("platform.ai_backfills")
      .set({
        status: res.stopCode && res.filled === 0 ? "failed" : "done",
        filled: res.filled,
        skipped: res.skipped,
        stop_code: res.stopCode,
        finished_at: i.now?.() ?? new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    out.push({ ...res, action: row.action });
  }
  return out;
}
