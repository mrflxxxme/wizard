// LLM gateway of runtime AI actions (runtime.yaml#ai_actions, M3-02): the runtime sends one call (action, record values
// as text, images/PDF of file fields) over the internal RPC; the platform checks, in this order, the platform LLM cap of
// the month (M2-15), the system's monthly limit aiAction.monthlyLimit and the org credits — none of them calls the
// model when refused — then routes callType runtime_ai_* (T0 only, @wizard/llm), journals the call and charges the
// org by fact (billing.yaml#run_charging.runtime_ai). Record values and answers are never stored here.
import {
  CircuitBreaker,
  createRegistry,
  createRouter,
  type LlmAttachment,
  LlmError,
  type LlmMode,
  type Router,
  type RouterOptions,
  type RuntimeAiAction,
  type RuntimeAiValue,
  routeRuntimeAi,
  runtimeAiCallType,
} from "@wizard/llm";
import { sql } from "kysely";
import { z } from "zod";
import type { Mailer } from "../auth/mailer.js";
import type { Billing } from "../billing/ledger.js";
import { moscowMonth } from "../billing/llm-cap.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { claimOpsAlert } from "../ops/alert.js";
import { DbUsageSink } from "../runs/usage.js";

/** Runtime error codes of runtime.yaml#data_api.error_codes the gateway answers with (+ AI_UNAVAILABLE, 503). */
export type AiGatewayCode =
  | "AI_LIMIT_REACHED"
  | "AI_CREDITS_EXHAUSTED"
  | "AI_UNAVAILABLE"
  | "NOT_FOUND"
  | "VALIDATION_FAILED";

export const AI_GATEWAY_STATUS: Record<AiGatewayCode, number> = {
  AI_LIMIT_REACHED: 429,
  AI_CREDITS_EXHAUSTED: 402,
  AI_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
};

export const AI_MESSAGES: Record<AiGatewayCode, string> = {
  AI_LIMIT_REACHED: "Лимит ИИ-действий на этот месяц исчерпан",
  AI_CREDITS_EXHAUSTED: "ИИ-действие временно недоступно",
  AI_UNAVAILABLE: "ИИ-действие временно недоступно, попробуйте позже",
  NOT_FOUND: "Система не найдена",
  VALIDATION_FAILED: "Некорректный запрос ИИ-действия",
};

export class AiGatewayError extends Error {
  constructor(
    readonly code: AiGatewayCode,
    message = AI_MESSAGES[code],
  ) {
    super(message);
    this.name = "AiGatewayError";
  }
}

const field = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  label: z.string().max(200),
  type: z.string().max(20),
  options: z
    .array(z.object({ value: z.string().max(100), label: z.string().max(200) }))
    .max(100)
    .optional(),
  maxLength: z.number().int().positive().max(100_000).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

/** Body of POST /internal/v1/ai/run (runtime → platform). */
export const aiRunSchema = z.object({
  /** systems.schema_key (= runtime systemId). */
  systemKey: z.string().regex(/^[a-z0-9]{12}$/),
  env: z.enum(["draft", "prod"]),
  /** Idempotency of the call: button — random, workflow — wf:<jobId>:<step>, backfill — bf:<backfillId>:<recordId>. */
  callId: z.string().min(8).max(200),
  source: z.enum(["button", "workflow", "backfill"]),
  monthlyLimit: z.number().int().min(1),
  action: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    kind: z.enum(["extract", "generate"]),
    instruction: z.string().max(1000).nullable(),
    outputs: z.array(field).min(1).max(30),
  }),
  record: z.array(z.object({ label: z.string().max(200), value: z.string().max(20_000) })).max(50),
  attachments: z
    .array(
      z.object({
        mime: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
        data: z.string().max(14_000_000),
      }),
    )
    .max(3)
    .optional(),
});
export type AiRunRequest = z.infer<typeof aiRunSchema>;

export interface AiRunResult {
  values: Record<string, RuntimeAiValue>;
  skipped: string[];
  tier: "T0";
  model: string;
  creditsMilli: number;
}

export interface AiGatewayOptions {
  db: Db;
  config: Config;
  billing: Billing;
  mailer?: Mailer;
  createRouter?: (opts: RouterOptions) => Router;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

/** Fixture of runtime AI calls in fixture mode (eval.yaml#fixtures, suite unit; WIZARD_AI_FIXTURE=<suite>/<name>). */
export const DEFAULT_AI_FIXTURE = "unit/runtime-ai";

export class AiGateway {
  readonly #o: AiGatewayOptions;
  #router: Router | null = null;
  readonly #circuit = new CircuitBreaker();

  constructor(o: AiGatewayOptions) {
    this.#o = o;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  /**
   * One router for all AI calls of this process. Record mode records only repository briefs (eval.yaml#fixtures.rules),
   * never live records: AI actions then run on their fixture like in fixture mode.
   */
  router(): Router {
    if (this.#router) return this.#router;
    const envMode = (process.env.WIZARD_LLM_MODE as LlmMode | undefined) ?? "fixture";
    const mode: LlmMode = envMode === "live" ? "live" : "fixture";
    const [suite, name] = (process.env.WIZARD_AI_FIXTURE || DEFAULT_AI_FIXTURE).split("/");
    const opts: RouterOptions = {
      mode,
      registry: createRegistry({ buildDefaultTier: this.#o.config.buildDefaultTier }),
      sink: new DbUsageSink(this.#o.db),
      circuit: this.#circuit,
      ...(mode === "fixture"
        ? {
            fixture: {
              suite: suite === "eval" || suite === "demo" ? suite : "unit",
              name: name || "runtime-ai",
              lenient: process.env.WIZARD_FIXTURE_LENIENT === "1",
            },
          }
        : {}),
    };
    this.#router = (this.#o.createRouter ?? createRouter)(opts);
    return this.#router;
  }

  async run(req: AiRunRequest): Promise<AiRunResult> {
    const { db, billing } = this.#o;
    const sys = await db
      .selectFrom("platform.systems")
      .select(["id", "org_id", "name", "suspended_at", "deleted_at"])
      .where("schema_key", "=", req.systemKey)
      .executeTakeFirst();
    if (!sys || sys.deleted_at) throw new AiGatewayError("NOT_FOUND");
    if (sys.suspended_at) throw new AiGatewayError("AI_UNAVAILABLE");

    // M2-15: the platform LLM cap of the month (alerts to the founder are sent by LlmMonthlyCap itself).
    try {
      await billing.assertLlmBudget(sys.org_id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "LLM_BUDGET_EXHAUSTED")
        throw new AiGatewayError("AI_UNAVAILABLE");
      throw e;
    }

    const callType = runtimeAiCallType(req.action.kind);
    const month = moscowMonth(this.#now());
    // Limit and credits are checked and the call journaled in one transaction under the system lock: concurrent
    // calls cannot pass the limit together.
    const claim = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`ai:${sys.id}`}))`.execute(trx);
      const prev = await trx
        .selectFrom("platform.ai_action_calls")
        .select(["status", "created_at"])
        .where("id", "=", req.callId)
        .executeTakeFirst();
      if (!prev) {
        const used = await trx
          .selectFrom("platform.ai_action_calls")
          .select(sql<string>`count(*)`.as("n"))
          .where("system_id", "=", sys.id)
          .where("action", "=", req.action.name)
          .where("status", "in", ["pending", "ok"])
          .where("created_at", ">=", month.start)
          .where("created_at", "<", month.end)
          .executeTakeFirstOrThrow();
        if (Number(used.n) >= req.monthlyLimit) return { refused: "AI_LIMIT_REACHED" as const };
      }
      await billing.settleOrg(trx, sys.org_id);
      const { available } = await billing.balance(trx, sys.org_id);
      if (available <= 0 && !billing.isExempt(sys.org_id))
        return { refused: "AI_CREDITS_EXHAUSTED" as const };
      const at = prev ? new Date(prev.created_at) : this.#now();
      if (prev)
        await trx
          .updateTable("platform.ai_action_calls")
          .set({ status: "pending", error_code: null, finished_at: null })
          .where("id", "=", req.callId)
          .execute();
      else
        await trx
          .insertInto("platform.ai_action_calls")
          .values({
            id: req.callId,
            org_id: sys.org_id,
            system_id: sys.id,
            env: req.env,
            action: req.action.name,
            call_type: callType,
            source: req.source,
            status: "pending",
            created_at: at,
          })
          .execute();
      return { refused: null, at };
    });
    if (claim.refused === "AI_CREDITS_EXHAUSTED")
      await this.#notifyOwners(sys.id, sys.org_id, sys.name, month.key);
    if (claim.refused) throw new AiGatewayError(claim.refused);

    let out: Awaited<ReturnType<typeof routeRuntimeAi>>;
    try {
      out = await routeRuntimeAi(this.router(), {
        action: req.action as RuntimeAiAction,
        record: req.record,
        ...(req.attachments?.length ? { attachments: req.attachments as LlmAttachment[] } : {}),
        // No org policy is passed (fail-safe T0); the callType forbids T1 anyway (data-boundary.yaml#call_types).
        ctx: { orgId: sys.org_id, systemId: sys.id, step: `ai:${req.action.name}` },
      });
    } catch (e) {
      const code = e instanceof LlmError ? e.code : "INTERNAL";
      await db
        .updateTable("platform.ai_action_calls")
        .set({ status: "error", error_code: code, finished_at: this.#now() })
        .where("id", "=", req.callId)
        .execute();
      if (!(e instanceof LlmError)) this.#o.log?.("runtime AI call failed", e);
      throw new AiGatewayError("AI_UNAVAILABLE");
    }

    const charged = await db.transaction().execute(async (trx) => {
      const milli = await billing.chargeAi(trx, {
        orgId: sys.org_id,
        systemId: sys.id,
        callId: req.callId,
        at: claim.at,
        amountMilli: out.creditsMilli,
        action: req.action.name,
      });
      await trx
        .updateTable("platform.ai_action_calls")
        .set({
          status: "ok",
          finished_at: this.#now(),
          credits_milli: sql`credits_milli + ${milli}`,
        })
        .where("id", "=", req.callId)
        .execute();
      return milli;
    });
    return { values: out.values, skipped: out.skipped, tier: "T0", model: out.model, creditsMilli: charged };
  }

  /** billing.yaml#run_charging.runtime_ai «владельцу — уведомление»: once per system and month (db.yaml#ops_alerts). */
  async #notifyOwners(systemId: string, orgId: string, name: string, month: string): Promise<void> {
    const { db, mailer } = this.#o;
    try {
      // The same once-per-key journal as founder alerts (ops/alert.ts claimOpsAlert, db.yaml#ops_alerts).
      if (!(await claimOpsAlert(db, `ai_credits:${systemId}:${month}`)) || !mailer) return;
      const owners = await db
        .selectFrom("platform.memberships as m")
        .innerJoin("platform.users as u", "u.id", "m.user_id")
        .select("u.email")
        .where("m.org_id", "=", orgId)
        .where("m.role", "=", "owner")
        .where("u.deleted_at", "is", null)
        .execute();
      const text = [
        `В системе «${name}» закончились кредиты организации, поэтому ИИ-действия (кнопки и автоматизации с ИИ) временно не работают.`,
        "Остальные функции системы работают как обычно. Пополните кредиты в разделе «Тариф и кредиты», и ИИ-действия снова станут доступны.",
      ].join("\n\n");
      for (const o of owners)
        await mailer.send({
          kind: "notice",
          to: o.email,
          subject: "Кредиты для ИИ-действий закончились",
          text,
        });
    } catch (e) {
      this.#o.log?.("AI credits notice failed", e);
    }
  }
}
