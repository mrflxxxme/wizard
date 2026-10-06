// Email connector: specs/connectors/email.yaml — transactional mail via the platform account or the client's SMTP.
import { randomUUID } from "node:crypto";
import { type AppSpec, EGRESS_HOST_RE } from "@wizard/appspec";
import { z } from "zod";
import { defineAction, defineConnector } from "./define.js";
import { ConnectorError } from "./errors.js";
import { sendUnisenderApi } from "./mail-api.js";
import {
  buildMessage,
  displayName,
  formatAddress,
  headerSafe,
  type InlineImage,
  isPlainAddress,
} from "./mime.js";
import { resolvePublic } from "./net.js";
import type { QrConfig } from "./qr.js";
import { qrPng } from "./qr-png.js";
import { consumeQuota, outboxMessage } from "./runtime.js";
import { type SmtpEndpoint, SmtpError, sendSmtp } from "./smtp.js";
import { cpText, entityOf, hasDeclaredSecret, IDENT_RE, Issues, placeholders } from "./spec-util.js";
import { appLabel } from "./telegram.js";
import {
  CANCEL_LINK_PLACEHOLDER,
  checkRecipient,
  notifySteps,
  RESCHEDULE_LINK_PLACEHOLDER,
  recipientKinds,
  renderTemplate,
  resolvePlaceholder,
} from "./templates.js";
import type { ConnectorCtx, SpecCheckContext, SpecIssue } from "./types.js";

const emailAddress = z.email({ error: "Некорректный адрес email" });

export const emailConfigSchema = z
  .strictObject({
    provider: z.enum(["platform", "smtp"]).optional(),
    host: z
      .string()
      .regex(EGRESS_HOST_RE, { error: "Хост SMTP — доменное имя без IP-адреса и порта" })
      .optional(),
    port: z.union([z.literal(465), z.literal(587)], { error: "Порт SMTP — 465 или 587" }).optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1).max(254).optional(),
    from: z
      .strictObject({
        name: cpText(1, 60).refine((s) => !/[@<>\r\n\0]/.test(s), {
          error: "Имя отправителя не может содержать @, <, > и переводы строк",
        }),
        address: emailAddress,
      })
      .optional(),
    replyTo: emailAddress.optional(),
    templates: z
      .record(
        z.string().regex(IDENT_RE, { error: "Идентификатор шаблона: латиница, цифры и _" }),
        z.strictObject({ subject: cpText(1, 120), body: cpText(1, 10000) }),
      )
      .optional(),
  })
  .superRefine((c, ctx) => {
    const provider = c.provider ?? "platform";
    if (provider === "smtp") {
      for (const k of ["host", "port", "secure", "user", "from"] as const) {
        if (c[k] === undefined) {
          ctx.addIssue({ code: "custom", path: [k], message: `Для своего SMTP укажите «${k}»` });
        }
      }
      if (c.port !== undefined && c.secure !== undefined && c.secure !== (c.port === 465)) {
        ctx.addIssue({
          code: "custom",
          path: ["secure"],
          message: "Порт 465 — secure: true (TLS сразу), порт 587 — secure: false (обязательный STARTTLS)",
        });
      }
    } else {
      for (const k of ["host", "port", "secure", "user"] as const) {
        if (c[k] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [k],
            message: "Настройки SMTP задаются только при provider: smtp",
          });
        }
      }
    }
  });
export type EmailConfig = z.infer<typeof emailConfigSchema>;

/** Templates referenced by notify steps: trigger entities per template id. */
function templateUsage(spec: AppSpec, integration: string) {
  const usage = new Map<string, ReturnType<typeof notifySteps>>();
  for (const step of notifySteps(spec, integration)) {
    const t = step.params.template;
    if (typeof t !== "string") continue;
    usage.set(t, [...(usage.get(t) ?? []), step]);
  }
  return usage;
}

/**
 * `{{cancel_link}}` (M2-50): the step declares `cancel: {set: {<field>: <value>}}` — what the one-time link writes to
 * the record (e.g. status → cancelled); only non-PII fields of the record, a visitor recipient only. B2-14: null clears
 * an optional field; `cancel.until` limits the link in time.
 */
function checkCancel(
  step: ReturnType<typeof notifySteps>[number],
  templates: NonNullable<EmailConfig["templates"]>,
): SpecIssue[] {
  const base = `/workflows/${step.wi}/steps/${step.si}/params`;
  const tpl = typeof step.params.template === "string" ? templates[step.params.template] : undefined;
  const uses = tpl
    ? [...placeholders(tpl.subject), ...placeholders(tpl.body)].includes(CANCEL_LINK_PLACEHOLDER)
    : false;
  const cancel = step.params.cancel;
  const issue = (message_ru: string, path = `${base}/cancel`): SpecIssue => ({
    code: "CONFIG_INVALID",
    path,
    message_ru,
    rule: "notify.cancel_link",
  });
  if (cancel === undefined) {
    return uses
      ? [
          issue(
            "Шаблон использует {{cancel_link}}: укажите cancel: {set: {поле: значение}} — что сделает ссылка отмены",
            `${base}/template`,
          ),
        ]
      : [];
  }
  const set = (cancel as { set?: unknown } | null)?.set;
  if (typeof set !== "object" || set === null || Array.isArray(set) || Object.keys(set).length === 0)
    return [issue("cancel: {set: {поле: значение}} — поля записи, которые меняет ссылка отмены")];
  if (!recipientKinds(step).has("visitor"))
    return [issue("Ссылка отмены отправляется только посетителю (получатель $record.<поле email>)")];
  const out: SpecIssue[] = [];
  for (const [k, v] of Object.entries(set)) {
    const f = step.entity?.fields.find((x) => x.name === k);
    if (!f || (f.pii ?? "none") !== "none" || f.type === "ref" || f.type === "file")
      out.push(
        issue(`Ссылка отмены может менять только обычные поля записи без персональных данных, а не «${k}»`),
      );
    // B2-14: null frees a value of an optional field (e.g. the seat of a unique slot index).
    else if (v === null && f.required)
      out.push(issue(`Поле «${k}» обязательное: ссылка отмены не может его очистить`));
    else if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
      out.push(issue(`Значение поля «${k}» для отмены — строка, число, да/нет или пусто (null)`));
  }
  out.push(...checkUntil(step, (cancel as { until?: unknown }).until, `${base}/cancel/until`));
  return out;
}

/** `until: {field, minutesBefore}` of a link: the link works until `record[field] − minutesBefore` (B2-14). */
function checkUntil(step: ReturnType<typeof notifySteps>[number], until: unknown, path: string): SpecIssue[] {
  if (until === undefined) return [];
  const u = until as { field?: unknown; minutesBefore?: unknown } | null;
  const f = typeof u?.field === "string" ? step.entity?.fields.find((x) => x.name === u.field) : undefined;
  const minutes = u?.minutesBefore;
  if (
    !f ||
    (f.type !== "datetime" && f.type !== "date") ||
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > 525_600
  )
    return [
      {
        code: "CONFIG_INVALID",
        path,
        message_ru:
          "until: {field: <поле даты и времени записи>, minutesBefore: <целое ≥ 0>} — до какого момента работает ссылка",
        rule: "notify.link_until",
      },
    ];
  return [];
}

const PLAIN_FIELD = (f: { pii?: string; type: string } | undefined) =>
  f !== undefined && (f.pii ?? "none") === "none" && !["file", "image", "json", "qr_token"].includes(f.type);

/**
 * `{{reschedule_link}}` (B2-14): the step declares `reschedule: {page, fields, keep?, set?, until?, when?}` — the
 * link opens `page` (with the token and the `keep` values in the query), the page posts new values of `fields`.
 */
function checkReschedule(
  step: ReturnType<typeof notifySteps>[number],
  templates: NonNullable<EmailConfig["templates"]>,
): SpecIssue[] {
  const base = `/workflows/${step.wi}/steps/${step.si}/params`;
  const tpl = typeof step.params.template === "string" ? templates[step.params.template] : undefined;
  const uses = tpl
    ? [...placeholders(tpl.subject), ...placeholders(tpl.body)].includes(RESCHEDULE_LINK_PLACEHOLDER)
    : false;
  const r = step.params.reschedule as
    | { page?: unknown; fields?: unknown; keep?: unknown; set?: unknown; until?: unknown; when?: unknown }
    | null
    | undefined;
  const issue = (message_ru: string, path = `${base}/reschedule`): SpecIssue => ({
    code: "CONFIG_INVALID",
    path,
    message_ru,
    rule: "notify.reschedule_link",
  });
  if (r === undefined)
    return uses
      ? [
          issue(
            "Шаблон использует {{reschedule_link}}: укажите reschedule: {page, fields} — страницу выбора нового времени и поля, которые она меняет",
            `${base}/template`,
          ),
        ]
      : [];
  if (r === null || typeof r !== "object" || Array.isArray(r))
    return [issue("reschedule: {page, fields, keep?, set?, until?, when?}")];
  if (!recipientKinds(step).has("visitor"))
    return [issue("Ссылка переноса отправляется только посетителю (получатель $record.<поле email>)")];
  const out: SpecIssue[] = [];
  if (typeof r.page !== "string" || !/^\/[a-z0-9/_-]*$/.test(r.page))
    out.push(issue("reschedule.page — адрес страницы системы, например /booking", `${base}/reschedule/page`));
  const fieldOf = (n: unknown) =>
    typeof n === "string" ? step.entity?.fields.find((x) => x.name === n) : undefined;
  const fields = Array.isArray(r.fields) ? r.fields : [];
  if (fields.length === 0 || fields.length > 8)
    out.push(
      issue("reschedule.fields — от 1 до 8 полей, которые меняет перенос", `${base}/reschedule/fields`),
    );
  for (const n of fields) {
    const f = fieldOf(n);
    if (!PLAIN_FIELD(f) || f?.type === "ref")
      out.push(
        issue(
          `Перенос может менять только обычные поля записи без персональных данных, а не «${String(n)}»`,
          `${base}/reschedule/fields`,
        ),
      );
  }
  const keep: unknown[] = r.keep === undefined ? [] : Array.isArray(r.keep) ? r.keep : [r.keep];
  for (const n of keep)
    if (!PLAIN_FIELD(fieldOf(n)) || fieldOf(n)?.ref?.entity === "users")
      out.push(
        issue(
          `Страница переноса может получить только поля без персональных данных, а не «${String(n)}»`,
          `${base}/reschedule/keep`,
        ),
      );
  for (const [k, v] of Object.entries(
    r.set && typeof r.set === "object" && !Array.isArray(r.set) ? r.set : {},
  ))
    if (
      !PLAIN_FIELD(fieldOf(k)) ||
      (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
    )
      out.push(issue(`reschedule.set: поле «${k}» — обычное поле без ПДн со строкой, числом или да/нет`));
  if (r.when !== undefined) {
    const w = r.when as Record<string, unknown> | null;
    if (!w || typeof w !== "object" || Array.isArray(w) || Object.keys(w).some((k) => !fieldOf(k)))
      out.push(issue("reschedule.when: {поле: значение | [значения]} — когда перенос ещё возможен"));
  }
  out.push(...checkUntil(step, r.until, `${base}/reschedule/until`));
  return out;
}

export function validateEmailSpec(config: EmailConfig, spec: AppSpec, at: SpecCheckContext) {
  const issues = new Issues(at);
  if ((config.provider ?? "platform") === "smtp" && !hasDeclaredSecret(at, "smtp_password")) {
    issues.add(
      "email.smtp_password_secret",
      [],
      "Для своего SMTP объявите secret://smtp_password в secretRefs",
    );
  }
  const templates = config.templates ?? {};
  const names = Object.keys(templates);
  const extra: SpecIssue[] = [];
  for (const step of notifySteps(spec, at.integration.name)) {
    extra.push(
      ...checkRecipient(spec, step, "email"),
      ...checkCancel(step, templates),
      ...checkReschedule(step, templates),
    );
    const t = step.params.template;
    if (typeof t !== "string" || !names.includes(t)) {
      extra.push({
        code: "CONFIG_INVALID",
        path: `/workflows/${step.wi}/steps/${step.si}/params/template`,
        message_ru: `Шаблон письма «${String(t ?? "")}» не найден в интеграции «${at.integration.name}»`,
        rule: "email.template_missing",
        allowed: names,
      });
    }
  }
  const usage = templateUsage(spec, at.integration.name);
  for (const [id, tpl] of Object.entries(templates)) {
    const steps = usage.get(id) ?? [];
    const entities = steps.length ? steps.map((s) => s.entity) : [undefined];
    // Subject: never PII (it is visible in mailbox lists and provider logs).
    for (const p of new Set(placeholders(tpl.subject))) {
      if (entities.some((e) => resolvePlaceholder(spec, e, p).pii)) {
        issues.add(
          "email.subject_pii",
          ["templates", id, "subject"],
          `Тема письма подставляет персональные данные «{{${p}}}» — уберите их из темы`,
        );
      }
    }
    // Body (M2-50, D71): PII of the record goes to the system's staff ($owner, $role) and to the record's owner; a
    // visitor gets only its own record's fields (no {{ref.field}} PII); other users — no PII.
    const bodyPii = [...new Set(placeholders(tpl.body))];
    for (const step of steps) {
      const leaks = bodyPii.filter((p) => resolvePlaceholder(spec, step.entity, p).pii);
      if (leaks.length === 0) continue;
      const kinds = recipientKinds(step);
      const list = leaks.map((p) => `{{${p}}}`).join(", ");
      if (kinds.has("user")) {
        extra.push({
          code: "CONFIG_INVALID",
          path: `/workflows/${step.wi}/steps/${step.si}/params/to`,
          message_ru: `Письмо «${id}» содержит персональные данные записи (${list}) — его можно отправить владельцу системы, сотрудникам роли, владельцу записи или самому посетителю`,
          rule: "email.body_pii_recipient",
        });
      } else if (kinds.has("visitor") && leaks.some((p) => p.includes("."))) {
        extra.push({
          code: "CONFIG_INVALID",
          path: `/workflows/${step.wi}/steps/${step.si}/params/to`,
          message_ru: `Письмо «${id}» посетителю подставляет чужие персональные данные (${list}) — посетителю можно писать только его собственные данные из записи`,
          rule: "email.body_pii_recipient",
        });
      }
    }
  }
  return [...issues.list, ...extra];
}

// ------------------------------------------------------------------------------------------------
// sending

/** email.yaml#limits: ≤ 300 messages an hour per system, Free — 100. */
const HOUR_MS = 60 * 60_000;
const LIMIT_PER_HOUR = { free: 100, paid: 300 } as const;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hostnameOf = (host: string) => new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).hostname;

/** Minimal HTML version (ui-kit mail template: no external images, no tracking). */
function htmlDocument(bodyHtml: string, qrCid: string | null): string {
  const qr = qrCid ? `<p><img src="cid:${qrCid}" alt="QR-код" width="240" height="240"></p>` : "";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328"><div style="max-width:560px;margin:0 auto;padding:16px">${bodyHtml.replace(/\r?\n/g, "<br>")}${qr}</div></body></html>`;
}

interface Sender {
  address: string;
  name: string;
}

function senderOf(ctx: ConnectorCtx, config: EmailConfig): Sender {
  if ((config.provider ?? "platform") === "smtp" && config.from) {
    return { address: config.from.address, name: displayName(config.from.name) };
  }
  return { address: `noreply@${ctx.platform.mailDomain}`, name: displayName(appLabel(ctx.system.spec)) };
}

function smtpFailure(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (!(e instanceof SmtpError))
    return new ConnectorError("UPSTREAM_UNAVAILABLE", "Почтовый сервер недоступен");
  const opts = { providerStatus: e.code, providerCode: e.phase };
  if (e.code === 0 && (e.phase === "starttls" || e.phase === "tls")) {
    return new ConnectorError(
      "CONFIG_INVALID",
      "Почтовый сервер не поддерживает защищённое соединение",
      opts,
    );
  }
  if (e.code === 535 || e.code === 534 || e.code === 530) {
    return new ConnectorError("AUTH_FAILED", "Почтовый сервер не принял логин или пароль", opts);
  }
  if (e.code === 550 || e.code === 551 || e.code === 553) {
    return new ConnectorError("RECIPIENT_UNAVAILABLE", "Почтовый ящик получателя недоступен", opts);
  }
  if (e.code === 0 || e.code === 421 || (e.code >= 450 && e.code < 500)) {
    return new ConnectorError("UPSTREAM_UNAVAILABLE", "Почтовый сервер временно недоступен", opts);
  }
  return new ConnectorError("INVALID_REQUEST", "Почтовый сервер отклонил письмо", opts);
}

interface SmtpRoute {
  kind: "smtp";
  endpoint: SmtpEndpoint;
  address: string;
  password?: string;
}

/** The platform account over the Unisender Go HTTP API (email.yaml#transport); the key is the SMTP password. */
interface ApiRoute {
  kind: "api";
  base: string;
  apiKey: string;
}

type Route = SmtpRoute | ApiRoute;

/**
 * Where a message goes: dev receiver (test mode), the platform account (SMTP or its HTTP API) or the client's SMTP
 * (after the SSRF check).
 */
async function routeOf(ctx: ConnectorCtx, config: EmailConfig): Promise<Route | null> {
  if (ctx.mode === "test") {
    const dev = ctx.platform.devSmtp;
    return dev ? { kind: "smtp", endpoint: dev, address: dev.host } : null;
  }
  if ((config.provider ?? "platform") === "platform") {
    const smtp = ctx.platform.smtp;
    if (!smtp) throw new ConnectorError("SECRET_MISSING", "Почтовый аккаунт платформы ещё не настроен");
    const api = ctx.platform.mailApi;
    if (api) return { kind: "api", base: api.base, apiKey: await ctx.platform.secrets.get("smtp_password") };
    const password = smtp.user ? await ctx.platform.secrets.get("smtp_password") : undefined;
    return { kind: "smtp", endpoint: smtp, address: smtp.host, ...(password ? { password } : {}) };
  }
  const host = config.host as string;
  const [address] = await resolvePublic(host, ctx.platform.resolve);
  return {
    kind: "smtp",
    endpoint: {
      host,
      port: config.port as number,
      tls: config.secure ? "implicit" : "starttls",
      user: config.user,
    },
    address: address as string,
    password: await ctx.secrets.get("smtp_password"),
  };
}

export interface ComposedMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  inline?: InlineImage[];
}

/** Builds the RFC 5322 message and sends it (or writes it to the outbox in test mode); returns its Message-ID. */
async function dispatch(
  ctx: ConnectorCtx,
  config: EmailConfig,
  mail: ComposedMail,
  meta: { action: string; template?: string; attachQrOf?: unknown; userId?: string },
): Promise<{ messageId: string }> {
  if (!isPlainAddress(mail.to))
    throw new ConnectorError("RECIPIENT_UNAVAILABLE", "У получателя некорректный адрес email");
  const route = await routeOf(ctx, config);
  const sender = senderOf(ctx, config);
  const domain = sender.address.split("@")[1] ?? hostnameOf(ctx.system.host);
  const messageId = `<${randomUUID()}@${domain}>`;
  const subject = headerSafe(mail.subject);
  const headers: [string, string][] = [
    ["Subject", subject],
    ["Date", ctx.now().toUTCString()],
    ["Message-ID", messageId],
    ["Auto-Submitted", "auto-generated"],
  ];
  const addressHeaders: [string, string][] = [
    ["From", formatAddress(sender.address, sender.name)],
    ["To", formatAddress(mail.to)],
  ];
  if (config.replyTo) addressHeaders.push(["Reply-To", formatAddress(config.replyTo)]);
  const eml = buildMessage({
    headers,
    addressHeaders,
    text: mail.text,
    html: mail.html,
    inline: mail.inline ?? [],
  });
  if (ctx.mode === "live") {
    const plan = ctx.system.plan ?? "free";
    await consumeQuota(
      ctx,
      "email_hour",
      LIMIT_PER_HOUR[plan],
      HOUR_MS,
      `Слишком много писем: не больше ${LIMIT_PER_HOUR[plan]} в час`,
    );
  }
  if (!route) {
    await ctx.outbox.write(
      outboxMessage(ctx, "email", meta.action, {
        ...(meta.userId ? { userId: meta.userId } : {}),
        to: mail.to,
        template: meta.template ?? null,
        headers: Object.fromEntries([...addressHeaders, ...headers]),
        text: mail.text,
        html: mail.html,
        attachQrOf: meta.attachQrOf ?? null,
        attachments: (mail.inline ?? []).map((a) => ({
          cid: a.cid,
          filename: a.filename,
          contentType: a.contentType,
          bytes: a.data.length,
        })),
        eml,
      }),
    );
    return { messageId };
  }
  if (route.kind === "api") {
    try {
      const { jobId } = await sendUnisenderApi(
        {
          from: sender.address,
          ...(sender.name ? { fromName: sender.name } : {}),
          to: mail.to,
          ...(config.replyTo ? { replyTo: config.replyTo } : {}),
          subject,
          text: mail.text,
          html: mail.html,
          inline: mail.inline ?? [],
          // The API takes only X- headers (Date and Message-ID are its own).
          headers: Object.fromEntries(headers.filter(([k]) => /^X-/i.test(k))),
        },
        { base: route.base, apiKey: route.apiKey, fetch: ctx.fetch },
      );
      return { messageId: jobId || messageId };
    } catch (e) {
      throw smtpFailure(e);
    }
  }
  try {
    await sendSmtp({
      endpoint: route.endpoint,
      address: route.address,
      ...(route.password !== undefined ? { password: route.password } : {}),
      from: sender.address,
      to: [mail.to],
      data: eml,
      dial: ctx.platform.dial,
      ...(ctx.platform.tlsCa ? { ca: ctx.platform.tlsCa } : {}),
      ehloName: domain,
    });
  } catch (e) {
    throw smtpFailure(e);
  }
  return { messageId };
}

/** PNG of the record's qr_token (qr integration of that entity); only the record owner may receive it. */
async function qrAttachment(ctx: ConnectorCtx, userId: string, ref: { entity: string; id: string }) {
  const spec = ctx.system.spec;
  const owner = entityOf(spec, ref.entity)?.ownerField;
  const row = owner ? await ctx.db.get(ref.entity, ref.id) : null;
  if (!row || row[owner as string] !== userId) {
    throw new ConnectorError("INVALID_REQUEST", "QR-код можно приложить только к письму владельцу записи");
  }
  const qr = (spec.integrations ?? []).find(
    (i) => i.connector === "qr" && (i.config as Partial<QrConfig> | undefined)?.entity === ref.entity,
  );
  const token = qr ? row[(qr.config as QrConfig).tokenField] : undefined;
  if (typeof token !== "string" || token === "") {
    throw new ConnectorError("INVALID_REQUEST", "У записи нет QR-кода");
  }
  const cid = `qr-${randomUUID()}@wizard`;
  return { cid, filename: "qr.png", contentType: "image/png" as const, data: qrPng(token) };
}

const sendInput = z.strictObject({
  userId: z.string().min(1),
  template: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  attachQrOf: z.strictObject({ entity: z.string().min(1), id: z.string().min(1) }).optional(),
  idempotencyKey: z.string().optional(),
});

/** Renders template `id` of the integration with `params` and sends it to `to` (+ an optional plain-text footer). */
async function sendRendered(
  ctx: ConnectorCtx,
  a: {
    to: string;
    template: string;
    params: Record<string, string | number>;
    footer?: string;
    inline?: InlineImage[];
    meta: { action: string; attachQrOf?: unknown; userId?: string };
  },
): Promise<{ messageId: string }> {
  const config = ctx.integration.config as EmailConfig;
  const tpl = config.templates?.[a.template];
  if (!tpl) throw new ConnectorError("CONFIG_INVALID", `Шаблон письма «${a.template}» не найден`);
  const inline = a.inline ?? [];
  const footer = a.footer ? `\n\n${a.footer}` : "";
  const bodyHtml = renderTemplate(escapeHtml(tpl.body), a.params, escapeHtml) + escapeHtml(footer);
  return dispatch(
    ctx,
    config,
    {
      to: a.to,
      subject: renderTemplate(tpl.subject, a.params, headerSafe),
      text: renderTemplate(tpl.body, a.params) + footer,
      html: htmlDocument(bodyHtml, inline[0]?.cid ?? null),
      inline,
    },
    { ...a.meta, template: a.template },
  );
}

async function sendTemplate(ctx: ConnectorCtx, input: z.infer<typeof sendInput>) {
  const config = ctx.integration.config as EmailConfig;
  if (!config.templates?.[input.template])
    throw new ConnectorError("CONFIG_INVALID", `Шаблон письма «${input.template}» не найден`);
  const to = await ctx.users.contact(input.userId, "email");
  if (!to) throw new ConnectorError("RECIPIENT_UNAVAILABLE", "У получателя нет адреса email");
  const inline = input.attachQrOf ? [await qrAttachment(ctx, input.userId, input.attachQrOf)] : [];
  return sendRendered(ctx, {
    to,
    template: input.template,
    params: input.params,
    inline,
    meta: { action: "sendTemplate", attachQrOf: input.attachQrOf, userId: input.userId },
  });
}

/**
 * Host-side template mail to an address the host resolved itself (M2-50: org owners from the platform, a visitor's
 * contact with consent). Never exposed to system code (ctx.connectors has only sendTemplate by userId).
 */
export async function sendTemplateToAddress(
  ctx: ConnectorCtx,
  a: { to: string; template: string; params: Record<string, string | number>; footer?: string },
): Promise<{ messageId: string }> {
  return sendRendered(ctx, { ...a, meta: { action: "sendTemplate" } });
}

/**
 * Host-side mail from the platform account (invitations, email OTP — runtime.yaml#auth): `to` is resolved by the
 * host, never by system code. Test mode → outbox or the dev receiver, as sendTemplate.
 */
export async function sendPlatformEmail(
  ctx: ConnectorCtx,
  mail: { to: string; subject: string; text: string; action: string },
): Promise<{ messageId: string }> {
  return dispatch(
    ctx,
    { provider: "platform" },
    {
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: htmlDocument(escapeHtml(mail.text), null),
    },
    { action: mail.action },
  );
}

export const emailConnector = defineConnector({
  id: "email",
  milestone: "M1",
  configSchema: emailConfigSchema,
  secrets: [{ name: "smtp_password", required: false, label: "Пароль SMTP (только provider=smtp)" }],
  validateSpec: validateEmailSpec,
  actions: {
    sendTemplate: defineAction({
      input: sendInput,
      output: z.object({ messageId: z.string() }),
      effect: true,
      retry: { attempts: 3, baseMs: 1000 },
      handler: sendTemplate,
    }),
  },
  testMode: (env) => (env === "draft" ? "test" : "live"),
  piiFields: ["to", "params", "subject", "body"],
});
