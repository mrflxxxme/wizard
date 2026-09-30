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
