// Usage accounting: models.yaml#credits, #usage_record; UsageSink (architecture.yaml#interfaces.usage_sink).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ModelDef } from "./registry.js";
import type { LlmUsage, UsageRecord, UsageSink } from "./types.js";

export function costRub(price: ModelDef["price"], u: LlmUsage): number {
  const cached = Math.min(u.cachedTokens, u.inputTokens);
  const raw =
    ((u.inputTokens - cached) * price.input) / 1e6 +
    (cached * price.cached) / 1e6 +
    (u.outputTokens * price.output) / 1e6;
  return Math.round(raw * 1e4) / 1e4;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Cached input tokens of a call (models.yaml#usage_record.cachedTokens): the SDK value (usage.prompt_tokens_details.
 * cached_tokens — Z.ai, DeepSeek, vLLM with --enable-prompt-tokens-details), else the raw usage of the provider —
 * prompt_cache_hit_tokens (DeepSeek) or a top-level cached_tokens (Kimi API). Never more than the input.
 */
export function cachedInputTokens(
  inputTokens: number,
  sdkCacheRead: number | undefined,
  raw: unknown,
): number {
  let cached = count(sdkCacheRead);
  if (cached === 0 && raw !== null && typeof raw === "object") {
    const u = raw as Record<string, unknown>;
    cached = count(u.prompt_cache_hit_tokens) || count(u.cached_tokens);
  }
  return Math.min(cached, Math.max(0, inputTokens));
}

export function creditsMilli(cost: number, rubPerCredit: number): number {
  // Round away float noise before ceil so that e.g. 0.30000000000000004 does not add a milli-credit.
  return Math.ceil(Math.round(((cost * 1000) / rubPerCredit) * 1e6) / 1e6);
}

/** Default sink outside the platform: one JSON line per record, `.data/usage.jsonl` relative to cwd. */
export class JsonlUsageSink implements UsageSink {
  readonly path: string;
  constructor(path = ".data/usage.jsonl") {
    this.path = resolve(path);
  }
  write(record: UsageRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

export class MemoryUsageSink implements UsageSink {
  readonly records: UsageRecord[] = [];
  write(record: UsageRecord): void {
    this.records.push(record);
  }
}
