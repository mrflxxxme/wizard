// architecture.yaml#interfaces.usage_sink: platform.llm_calls (never prompt or response text).
import type { UsageRecord, UsageSink } from "@wizard/llm";
import { type Db, json } from "../db/index.js";

export class DbUsageSink implements UsageSink {
  constructor(private readonly db: Db) {}
  async write(r: UsageRecord): Promise<void> {
    await this.db
      .insertInto("platform.llm_calls")
      .values({
        id: r.id,
        org_id: r.orgId,
        system_id: r.systemId,
        run_id: r.runId,
        step: r.step,
        call_type: r.callType,
        agent_role: r.agentRole,
        tier: r.tier,
        provider: r.provider,
        model_id: r.modelId,
        attempt: r.attempt,
        status: r.status,
        error_code: r.errorCode,
        route_reason: r.routeReason,
        fallback_from: r.fallbackFrom,
        policy_version: r.policyVersion,
        scrubbed: r.scrubbed,
        pii_categories_count: json(r.piiCategoriesCount),
        input_tokens: r.inputTokens,
        cached_tokens: r.cachedTokens,
        output_tokens: r.outputTokens,
        tool_calls: r.toolCalls,
        latency_ms: Math.round(r.latencyMs),
        ttft_ms: r.ttftMs === null ? null : Math.round(r.ttftMs),
        cost_rub: r.costRub,
        credits_milli: r.creditsMilli,
        billable: r.billable,
        mode: r.mode,
        request_hash: r.requestHash,
        created_at: r.createdAt,
      })
      .execute();
  }
}
