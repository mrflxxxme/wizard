// Workflow step `notify` (runtime.yaml#workflows.step_params; email.yaml, telegram.yaml notify_step): resolves the
// recipients on the host, renders the template with record values and sends one message per recipient with its own
// idempotency key. M2-50 (D69, D71): recipients `$record.<ref to users>`, `$owner` (org owners), `$role:<role>` and a
// visitor's contact `$record.<email field>` only with the record's consent field set; journal _w_messages.
import { createHash } from "node:crypto";
import type { Entity } from "@wizard/appspec";
import { emailConnector, sendTemplateToAddress } from "./email.js";
import { ConnectorError, isConnectorError } from "./errors.js";
import { headerSafe, isPlainAddress } from "./mime.js";
import { CALL_TTL_MS, consumeQuota, type InvokeOptions, invokeAction } from "./runtime.js";
import { entityOf, fieldOf, placeholders } from "./spec-util.js";
import { telegramConnector } from "./telegram.js";
import {
  CANCEL_LINK_PLACEHOLDER,
  LINK_PLACEHOLDER,
  parseRecipients,
  RESCHEDULE_LINK_PLACEHOLDER,
  type RecipientRef,
  recordRecipientKind,
  renderTemplate,
  UNSUBSCRIBE_LINK_PLACEHOLDER,
} from "./templates.js";
import type { ConnectorCtx, MessageJournalEntry, Row } from "./types.js";

export interface NotifyStepInput {
  /** params of the step: {integration, to, template | text, consentField?, cancel?, reschedule?, attachQr?, link?}. */
  params: Record<string, unknown>;
  entity: string;
  record: Row;
  /** _w_jobs id and step index: the idempotency key is `<jobId>:<stepIndex>:<action>:<recipient>`. */
  jobId: string;
  stepIndex: number;
  /** Workflow name (journal only). */
  workflow?: string;
}

export interface NotifyResult {
  /** Messages handed to the channel (or replayed for a repeated key). */
  sent: number;
  /** Recipients skipped: no consent, no address, chat not linked, contact limit. */
  skipped: number;
}

/** compliance.yaml#system_package.consent.purposes.messages (executability MP-26): per contact and day. */
export const VISITOR_MESSAGES_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;
/** `$role:<role>` fan-out bound of one step. */
const MAX_ROLE_RECIPIENTS = 200;

/** Footer of every visitor message (only with a signed link available). */
export const UNSUBSCRIBE_FOOTER_RU = "Чтобы больше не получать писем по этой записи, перейдите по ссылке:";

function scalar(v: unknown): string | number | undefined {
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "да" : "нет";
  return undefined;
}

/** Default timezone of a system without app.timezone (runtime.yaml#workflows: schedules run in Moscow time). */
const DEFAULT_TIMEZONE = "Europe/Moscow";

/**
 * A date or date-time field as a person reads it — «9 октября 2026, 10:00» in the system's timezone, a date —
 * «9 октября 2026» — not the stored ISO string (B2-28: a reminder said «2026-10-09T07:00:00.000Z»). Other values as
 * scalar().
 */
function display(v: unknown, type: string | undefined, timeZone: string): string | number | undefined {
  if ((type === "datetime" || type === "date") && (typeof v === "string" || v instanceof Date)) {
    const dateOnly = type === "date" && typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v);
    const d = v instanceof Date ? v : new Date(dateOnly ? `${v}T12:00:00Z` : v);
    if (Number.isFinite(d.getTime())) {
      const tz = type === "date" ? "UTC" : timeZone;
      // Day, month and year without the «г.» Intl adds: templates end sentences with their own full stop.
      const day = new Intl.DateTimeFormat("ru-RU", {
        timeZone: tz,
        day: "numeric",
        month: "long",
        year: "numeric",
      })
        .formatToParts(d)
        .filter((p) => p.type === "day" || p.type === "month" || p.type === "year")
        .map((p) => p.value)
        .join(" ");
      if (type === "date") return day;
      const time = new Intl.DateTimeFormat("ru-RU", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      return `${day}, ${time.format(d)}`;
    }
  }
  return scalar(v);
}

/** Values for `{{field}}`, `{{ref.field}}` and the link placeholders used by the template (refs read as __system). */
async function valuesFor(
  ctx: ConnectorCtx,
  entity: Entity | undefined,
  record: Row,
  template: string,
  links: Record<string, string>,
): Promise<Record<string, string | number>> {
  const out: Record<string, string | number> = {};
  const tz = ctx.system.spec.app.timezone ?? DEFAULT_TIMEZONE;
  for (const p of new Set(placeholders(template))) {
    if (Object.hasOwn(links, p)) {
      out[p] = links[p] as string;
      continue;
    }
    const [head, tail] = p.split(".") as [string, string | undefined];
    if (tail === undefined) {
      const v = display(record[head], fieldOf(entity, head)?.type, tz);
      if (v !== undefined) out[p] = v;
      continue;
    }
    const f = fieldOf(entity, head);
    const target = f?.type === "ref" ? f.ref?.entity : undefined;
    const id = record[head];
    if (!target || typeof id !== "string" || !entityOf(ctx.system.spec, target)) continue;
    const row = await ctx.db.get(target, id);
    const v = display(row?.[tail], fieldOf(entityOf(ctx.system.spec, target), tail)?.type, tz);
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

const sha256 = (s: string) => createHash("sha256").update(s.trim().toLowerCase()).digest();
const short = (s: string) => sha256(s).toString("hex").slice(0, 16);

/** One resolved recipient: a system user (email/Telegram by userId) or a bare address (owner without an account, visitor). */
type Target =
  | { kind: "user" | "role" | "owner"; userId: string; key: string }
  | { kind: "owner" | "visitor"; address: string; key: string };

interface Resolved {
  targets: Target[];
  /** Recipients dropped before sending, for the journal. */
  dropped: { recipient: string; status: string; address?: string }[];
}

async function resolveTargets(
  ctx: ConnectorCtx,
  refs: RecipientRef[],
  entity: Entity | undefined,
  record: Row,
  params: Record<string, unknown>,
  channel: "email" | "telegram",
): Promise<Resolved> {
  const out: Resolved = { targets: [], dropped: [] };
  const seen = new Set<string>();
  const add = (t: Target) => {
    const id = "userId" in t ? `u:${t.userId}` : `a:${t.address.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.targets.push(t);
  };
  for (const r of refs) {
    if (r.kind === "role") {
      const ids = (await ctx.users.byRole?.(r.role)) ?? [];
      for (const userId of ids.slice(0, MAX_ROLE_RECIPIENTS))
        add({ kind: "role", userId, key: `u${userId}` });
      continue;
    }
    if (r.kind === "owner") {
      const emails = ((await ctx.owners?.()) ?? []).filter(isPlainAddress);
      if (emails.length === 0) {
        out.dropped.push({ recipient: "owner", status: "no_address" });
        continue;
      }
      if (channel === "telegram") {
        // Owners get Telegram only as users of the system with a linked chat (telegram.yaml#chat_linking).
        const ids = (await ctx.users.byEmail?.(emails)) ?? [];
        if (ids.length === 0) out.dropped.push({ recipient: "owner", status: "not_linked" });
        for (const userId of ids) add({ kind: "owner", userId, key: `u${userId}` });
      } else {
        for (const address of emails) add({ kind: "owner", address, key: `o${short(address)}` });
      }
      continue;
    }
    const kind = recordRecipientKind(entity, r.field);
    const value = record[r.field];
    if (kind === "user") {
      if (typeof value === "string" && value !== "")
        add({ kind: "user", userId: value, key: refs.length === 1 ? "0" : `u${value}` });
      else out.dropped.push({ recipient: "user", status: "no_address" });
      continue;
    }
    if (kind !== "visitor" || channel !== "email") {
      out.dropped.push({ recipient: "visitor", status: "failed" });
      continue;
    }
    // D69: a visitor without an account gets service mail only with the consent the form recorded on the record.
    const consentField = typeof params.consentField === "string" ? params.consentField : null;
    if (!consentField || record[consentField] !== true) {
      out.dropped.push({ recipient: "visitor", status: "no_consent" });
      continue;
    }
    if (typeof value !== "string" || !isPlainAddress(value)) {
      out.dropped.push({ recipient: "visitor", status: "no_address" });
      continue;
    }
    add({ kind: "visitor", address: value, key: "v" });
  }
  return out;
}

/** Stored result of a host-side effect under `key` (same TTL and store as invokeAction's idempotency). */
async function once<T>(
  ctx: ConnectorCtx,
  key: string,
  fn: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const cacheKey = `call:notify:${key}`;
  const hit = await ctx.store.get<{ output: T }>(cacheKey);
  if (hit) return { value: hit.output, replayed: true };
  const value = await fn();
  await ctx.store.set(cacheKey, { output: value }, CALL_TTL_MS);
  return { value, replayed: false };
}

async function journal(ctx: ConnectorCtx, e: MessageJournalEntry): Promise<void> {
  try {
    await ctx.messages?.write(e);
  } catch {
    // The journal never fails a delivery (missing table on an old schema, transient errors).
  }
}

/**
 * Runs one notify step; a repeated run with the same jobId/stepIndex sends nothing again (per-recipient keys). A
 * recipient that cannot be reached (no consent, no address, not linked, contact limit) is journaled and skipped; a
 * channel error of a single-recipient step is thrown (the job retries), of a fan-out — journaled.
 */
export async function runNotifyStep(
  ctx: ConnectorCtx,
  step: NotifyStepInput,
  opts: InvokeOptions = {},
): Promise<NotifyResult> {
  const refs = parseRecipients(step.params.to);
  if (!refs) throw new ConnectorError("RECIPIENT_UNAVAILABLE", "У записи нет получателя уведомления");
  const spec = ctx.system.spec;
  const entity = entityOf(spec, step.entity);
  const connectorId = spec.integrations?.find((i) => i.name === ctx.integration.name)?.connector;
  if (connectorId !== "email" && connectorId !== "telegram")
    throw new ConnectorError("CONFIG_INVALID", "Уведомления отправляют только интеграции email и Telegram");
  const channel = connectorId;
  const { targets, dropped } = await resolveTargets(ctx, refs, entity, step.record, step.params, channel);
  const base = {
    workflow: step.workflow ?? null,
    step: step.stepIndex,
    integration: ctx.integration.name,
    channel,
  } as const;
  const template = channel === "email" ? String(step.params.template ?? "") : null;
  for (const d of dropped)
    await journal(ctx, {
      ...base,
      recipient: d.recipient,
      addressHash: null,
      template,
      status: d.status,
      errorCode: null,
    });
  // A single `$record.<user>` recipient without a value keeps the M1 behaviour: the step fails visibly.
  if (
    targets.length === 0 &&
    refs.length === 1 &&
    refs[0]?.kind === "record" &&
    dropped[0]?.recipient === "user"
  )
    throw new ConnectorError("RECIPIENT_UNAVAILABLE", "У записи нет получателя уведомления");
  const link = linkOf(ctx, step.record, step.params.link);
  const result: NotifyResult = { sent: 0, skipped: dropped.length };
  const fanOut = targets.length > 1;
  for (const t of targets) {
    const action = channel === "email" ? "sendTemplate" : "sendToUser";
    const key = `${step.jobId}:${step.stepIndex}:${action}:${t.key}`;
    const entry = {
      ...base,
      recipient: t.kind,
      addressHash: "address" in t ? sha256(t.address) : null,
      template,
    };
    try {
      const status = await sendOne(ctx, channel, step, entity, link, t, key, opts);
      result.sent += status === "skipped" ? 0 : 1;
      result.skipped += status === "skipped" ? 1 : 0;
      await journal(ctx, { ...entry, status: status === "skipped" ? "not_linked" : status, errorCode: null });
    } catch (e) {
      const code = isConnectorError(e) ? e.code : "INTERNAL";
      await journal(ctx, {
        ...entry,
        status: code === "RATE_LIMITED" ? "rate_limited" : "failed",
        errorCode: code,
      });
      if (!fanOut) throw e;
      result.skipped += 1;
    }
  }
  return result;
}

type MailTemplate = { subject: string; body: string };

const templateOf = (ctx: ConnectorCtx, id: string): MailTemplate | undefined =>
  (ctx.integration.config as { templates?: Record<string, MailTemplate> }).templates?.[id];

/** Link placeholders of a letter: {{link}}; a visitor's letter also gets its one-time links and the unsubscribe footer. */
function mailLinks(
  ctx: ConnectorCtx,
  step: NotifyStepInput,
  link: string,
  visitor: boolean,
): { links: Record<string, string>; footer?: string } {
  const links: Record<string, string> = { [LINK_PLACEHOLDER]: link };
  if (!visitor) return { links };
  let footer: string | undefined;
  const at = {
    entity: step.entity,
    id: String(step.record.id),
    workflow: step.workflow ?? "",
    step: step.stepIndex,
  };
  const unsubscribe = ctx.messageLinks?.url({ action: "unsubscribe", ...at }) ?? null;
  if (unsubscribe) {
    links[UNSUBSCRIBE_LINK_PLACEHOLDER] = unsubscribe;
    footer = `${UNSUBSCRIBE_FOOTER_RU} ${unsubscribe}`;
  }
  const cancel = step.params.cancel ? (ctx.messageLinks?.url({ action: "cancel", ...at }) ?? null) : null;
  if (cancel) links[CANCEL_LINK_PLACEHOLDER] = cancel;
  const reschedule = step.params.reschedule
    ? (ctx.messageLinks?.url({ action: "reschedule", ...at }) ?? null)
    : null;
  if (reschedule) links[RESCHEDULE_LINK_PLACEHOLDER] = reschedule;
  return footer ? { links, footer } : { links };
}

/**
 * The letter an e-mail notify step sends to one kind of recipient, rendered as sendTemplate renders it (record values,
 * {{link}}, a visitor's one-time cancel/reschedule links and the unsubscribe footer) — without sending it. The G1
 * runtime in outbox mode records it next to the recipient marker, so goal scenarios follow the real links (B2-28).
 * null — the step has no such template.
 */
export async function renderNotifyEmail(
  ctx: ConnectorCtx,
  step: NotifyStepInput,
  recipient: "user" | "role" | "owner" | "visitor",
): Promise<{ subject: string; text: string } | null> {
  const tpl = templateOf(ctx, String(step.params.template ?? ""));
  if (!tpl) return null;
  const entity = entityOf(ctx.system.spec, step.entity);
  const { links, footer } = mailLinks(
    ctx,
    step,
    linkOf(ctx, step.record, step.params.link),
    recipient === "visitor",
  );
  const params = await valuesFor(ctx, entity, step.record, `${tpl.subject}\n${tpl.body}`, links);
  return {
    subject: renderTemplate(tpl.subject, params, headerSafe),
    text: renderTemplate(tpl.body, params) + (footer ? `\n\n${footer}` : ""),
  };
}

/** Sends to one target; returns sent | replayed | test_mode | skipped (Telegram chat not linked). */
async function sendOne(
  ctx: ConnectorCtx,
  channel: "email" | "telegram",
  step: NotifyStepInput,
  entity: Entity | undefined,
  link: string,
  t: Target,
  key: string,
  opts: InvokeOptions,
): Promise<"sent" | "replayed" | "test_mode" | "skipped"> {
  const keyed = { ...ctx, idempotencyKey: key };
  const sentOrTest = (): "sent" | "test_mode" => (ctx.mode === "test" ? "test_mode" : "sent");
  if (channel === "telegram") {
    if (!("userId" in t)) return "skipped";
    const text = String(step.params.text ?? "");
    const values = await valuesFor(ctx, entity, step.record, text, { [LINK_PLACEHOLDER]: link });
    const out = (await invokeAction(
      telegramConnector,
      "sendToUser",
      keyed,
      { userId: t.userId, text: renderTemplate(text, values) },
      opts,
    )) as { delivered?: boolean; reason?: string };
    if (out?.delivered === false && out.reason !== "test_mode") return "skipped";
    return sentOrTest();
  }
  const template = String(step.params.template ?? "");
  const tpl = templateOf(ctx, template);
  const { links, footer } = mailLinks(ctx, step, link, t.kind === "visitor");
  const params = tpl ? await valuesFor(ctx, entity, step.record, `${tpl.subject}\n${tpl.body}`, links) : {};
  if ("userId" in t) {
    const input: Record<string, unknown> = { userId: t.userId, template, params };
    if (step.params.attachQr === true && t.kind === "user")
      input.attachQrOf = { entity: step.entity, id: step.record.id };
    const hit = await ctx.store.get(`call:sendTemplate:${key}`);
    await invokeAction(emailConnector, "sendTemplate", keyed, input, opts);
    return hit ? "replayed" : sentOrTest();
  }
  const address = t.address;
  const r = await once(keyed, key, async () => {
    // Visitor protection (MP-26): ≤ 3 messages a day per contact and integration.
    if (t.kind === "visitor")
      await consumeQuota(
        ctx,
        `visitor:${short(address)}`,
        VISITOR_MESSAGES_PER_DAY,
        DAY_MS,
        `Не больше ${VISITOR_MESSAGES_PER_DAY} писем посетителю в сутки`,
      );
    const started = Date.now();
    try {
      const out = await sendTemplateToAddress(keyed, {
        to: address,
        template,
        params,
        ...(footer ? { footer } : {}),
      });
      ctx.log.log({
        action: "sendTemplate",
        mode: ctx.mode,
        idempotencyKey: key,
        status: "ok",
        durationMs: Date.now() - started,
      });
      return out;
    } catch (e) {
      ctx.log.log({
        action: "sendTemplate",
        mode: ctx.mode,
        idempotencyKey: key,
        status: "error",
        errorCode: isConnectorError(e) ? e.code : "INTERNAL",
        durationMs: Date.now() - started,
      });
      throw e;
    }
  });
  return r.replayed ? "replayed" : sentOrTest();
}
