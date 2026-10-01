// Workflow step `notify` (runtime.yaml#workflows.step_params; email.yaml, telegram.yaml notify_step): renders the
// template with record values on the host and calls the connector action with the step's idempotency key.
import type { Entity } from "@wizard/appspec";
import { emailConnector } from "./email.js";
import { ConnectorError } from "./errors.js";
import { type InvokeOptions, invokeAction } from "./runtime.js";
import { entityOf, fieldOf, placeholders } from "./spec-util.js";
import { telegramConnector } from "./telegram.js";
import { LINK_PLACEHOLDER, recordField, renderTemplate } from "./templates.js";
import type { ConnectorCtx, Row } from "./types.js";

export interface NotifyStepInput {
  /** params of the step: {integration, to: '$record.<field>', template | text, attachQr?, link?}. */
  params: Record<string, unknown>;
  entity: string;
  record: Row;
  /** _w_jobs id and step index: the idempotency key is `<jobId>:<stepIndex>:<action>:0`. */
  jobId: string;
  stepIndex: number;
}

function scalar(v: unknown): string | number | undefined {
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "да" : "нет";
  return undefined;
}

/** Values for `{{field}}`, `{{ref.field}}` and `{{link}}` used by the template (refs read as __system). */
async function valuesFor(
  ctx: ConnectorCtx,
  entity: Entity | undefined,
  record: Row,
  template: string,
  link: string,
): Promise<Record<string, string | number>> {
  const out: Record<string, string | number> = {};
  for (const p of new Set(placeholders(template))) {
    if (p === LINK_PLACEHOLDER) {
      out[p] = link;
      continue;
    }
    const [head, tail] = p.split(".") as [string, string | undefined];
    if (tail === undefined) {
      const v = scalar(record[head]);
      if (v !== undefined) out[p] = v;
      continue;
    }
    const f = fieldOf(entity, head);
    const target = f?.type === "ref" ? f.ref?.entity : undefined;
    const id = record[head];
    if (!target || typeof id !== "string" || !entityOf(ctx.system.spec, target)) continue;
    const row = await ctx.db.get(target, id);
    const v = scalar(row?.[tail]);
    if (v !== undefined) out[p] = v;
  }
  return out;
}

/** `$record.<field>` substitutions in a relative link; default — the system's root. */
function linkOf(ctx: ConnectorCtx, record: Row, raw: unknown): string {
  const origin = new URL(
    /^https?:\/\//.test(ctx.system.host) ? ctx.system.host : `https://${ctx.system.host}`,
  );
  const path =
    typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//")
      ? raw.replace(/\$record\.([a-z][a-z0-9_]*)/g, (_, f: string) =>
          encodeURIComponent(String(record[f] ?? "")),
        )
      : "/";
  return new URL(path, origin).toString();
}

/** Runs one notify step; a repeated run with the same jobId/stepIndex returns the stored result without sending. */
export async function runNotifyStep(
  ctx: ConnectorCtx,
  step: NotifyStepInput,
  opts: InvokeOptions = {},
): Promise<unknown> {
  const field = recordField(step.params.to);
  const userId = field ? step.record[field] : undefined;
  if (typeof userId !== "string" || userId === "") {
    throw new ConnectorError("RECIPIENT_UNAVAILABLE", "У записи нет получателя уведомления");
  }
  const entity = entityOf(ctx.system.spec, step.entity);
  const link = linkOf(ctx, step.record, step.params.link);
  const connectorId = ctx.system.spec.integrations?.find((i) => i.name === ctx.integration.name)?.connector;
  if (connectorId === "email") {
    const template = String(step.params.template ?? "");
    const tpl = (ctx.integration.config as { templates?: Record<string, { subject: string; body: string }> })
      .templates?.[template];
    const params = tpl ? await valuesFor(ctx, entity, step.record, `${tpl.subject}\n${tpl.body}`, link) : {};
    const action = "sendTemplate";
    const input: Record<string, unknown> = { userId, template, params };
    if (step.params.attachQr === true) input.attachQrOf = { entity: step.entity, id: step.record.id };
    return invokeAction(
      emailConnector,
      action,
      { ...ctx, idempotencyKey: `${step.jobId}:${step.stepIndex}:${action}:0` },
      input,
      opts,
    );
  }
  if (connectorId === "telegram") {
    const text = String(step.params.text ?? "");
    const values = await valuesFor(ctx, entity, step.record, text, link);
    const action = "sendToUser";
    return invokeAction(
      telegramConnector,
      action,
      { ...ctx, idempotencyKey: `${step.jobId}:${step.stepIndex}:${action}:0` },
      { userId, text: renderTemplate(text, values) },
      opts,
    );
  }
  throw new ConnectorError("CONFIG_INVALID", "Уведомления отправляют только интеграции email и Telegram");
}
