// POST /api/ai/:action {entity, id} (runtime.yaml#ai_actions, sdk.md useAiAction, M3-02): the button of an AI action.
// The caller needs read access to the record and the update operation on its entity; the result is written as
// __system and the answer is the record as the caller sees it, with `_aiFilled`. Input from the public role is limited
// to ≤ 10 calls per hour per client network (L3-41) before anything else happens.
import { randomUUID } from "node:crypto";
import { aiTargetFields } from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { compilePolicy } from "@wizard/sdk/host";
import { Hono } from "hono";
import { aiFilledFields, findAiAction, runAiAction } from "../ai/actions.js";
import type { RuntimeHonoEnv } from "../http/context.js";
import { errorResponse } from "../http/errors.js";
import { subjectOf } from "../http/subject.js";
import { readJsonBody } from "./data.js";

/** runtime.yaml#ai_actions.limits: calls of the public role per client network per hour in one system. */
export const AI_PUBLIC_PER_HOUR = 10;

/** Sliding one-hour window per key (in-process, like the upload limit of routes/files.ts). */
export class HourlyLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perHour: number) {}
  /** Seconds to wait, or 0 when the call may go (and is counted). */
  take(key: string, now: number): number {
    const from = now - 3600_000;
    const list = (this.hits.get(key) ?? []).filter((t) => t > from);
    if (list.length >= this.perHour) {
      this.hits.set(key, list);
      return Math.max(1, Math.ceil(((list[0] as number) + 3600_000 - now) / 1000));
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.hits.delete(this.hits.keys().next().value as string);
    return 0;
  }
}

export function aiRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  const limiter = new HourlyLimiter(AI_PUBLIC_PER_HOUR);

  app.post("/:action", async (c) => {
    const sys = c.get("system");
    const services = c.get("services");
    const subject = await subjectOf(c);
    const isPublic =
      subject.id === null && sys.spec.roles.some((r) => r.name === subject.role && r.access === "public");
    if (isPublic) {
      const net = services.ipHmac?.(c.req.raw)?.toString("hex") ?? "unknown";
      const wait = limiter.take(`${sys.schema}:${net}`, services.clock().getTime());
      if (wait > 0) {
        const res = errorResponse(new WizardError("RATE_LIMITED"), c.get("requestId"));
        res.headers.set("Retry-After", String(wait));
        return res;
      }
    }
    const body = (await readJsonBody(c)) as { entity?: unknown; id?: unknown } | null;
    const action = findAiAction(sys, c.req.param("action"));
    const entity = action.entity.name;
    if (body?.entity !== undefined && body.entity !== entity)
      throw new WizardError("VALIDATION_FAILED", { message: "ИИ-действие относится к другому разделу" });
    if (typeof body?.id !== "string" || body.id === "")
      throw new WizardError("VALIDATION_FAILED", { message: "Укажите запись (id)" });
    const id = body.id;
    const policy = compilePolicy(sys.spec, entity, {
      id: subject.id,
      role: subject.role,
      record: subject.record,
    });
    if (!policy.allows("update")) throw new WizardError("FORBIDDEN");
    // The record must be visible to the caller (rowFilter): NOT_FOUND otherwise, nothing is called.
    await sys.data.get(subject, entity, id);
    const out = await runAiAction(sys, services.ai, {
      action,
      recordId: id,
      callId: `btn:${randomUUID()}`,
      source: "button",
    });
    const item = await sys.data.get(subject, entity, id);
    const visible = new Set(Object.keys(item));
    const marked = await aiFilledFields(sys, entity, id, aiTargetFields(sys.spec, entity));
    return c.json({
      item: { ...item, _aiFilled: marked.filter((f) => visible.has(f)) },
      filled: out.filled.filter((f) => visible.has(f)),
      skipped: out.skipped.filter((f) => visible.has(f)),
    });
  });

  return app;
}
