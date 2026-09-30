// Email connector: specs/connectors/email.yaml. M0 — config/G0 and a test-mode sendTemplate into the outbox.
import { randomUUID } from "node:crypto";
import { type AppSpec, EGRESS_HOST_RE } from "@wizard/appspec";
import { z } from "zod";
import { defineAction, defineConnector } from "./define.js";
import { ConnectorError } from "./errors.js";
import { outboxMessage, requireTestMode } from "./runtime.js";
import { cpText, entityOf, hasDeclaredSecret, IDENT_RE, Issues } from "./spec-util.js";
import type { ConnectorCtx, SpecCheckContext } from "./types.js";

const emailAddress = z.email({ error: "Некорректный адрес email" });
const HEADER_UNSAFE = /[\r\n\0]/g;

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
        name: cpText(1, 60).refine((s) => !/[@<>\r\n]/.test(s), {
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

export function validateEmailSpec(config: EmailConfig, spec: AppSpec, at: SpecCheckContext) {
  const issues = new Issues(at);
  if ((config.provider ?? "platform") === "smtp" && !hasDeclaredSecret(at, "smtp_password")) {
    issues.add(
      "email.smtp_password_secret",
      [],
      "Для своего SMTP объявите secret://smtp_password в secretRefs",
    );
  }
  const templates = Object.keys(config.templates ?? {});
  (spec.workflows ?? []).forEach((w, wi) => {
    w.steps.forEach((s, si) => {
      const p = s.params ?? {};
      if (s.type !== "notify" || p.integration !== at.integration.name) return;
      const t = p.template;
      if (typeof t !== "string" || !templates.includes(t)) {
        issues.list.push({
          code: "CONFIG_INVALID",
          path: `/workflows/${wi}/steps/${si}/params/template`,
          message_ru: `Шаблон письма «${String(t ?? "")}» не найден в интеграции «${at.integration.name}»`,
          rule: "email.template_missing",
          allowed: templates,
        });
      }
    });
  });
  return issues.list;
}

function render(template: string, params: Record<string, string | number>, esc: (s: string) => string) {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, k: string) =>
    k in params ? esc(String(params[k])) : "",
  );
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const headerSafe = (s: string) => s.replace(HEADER_UNSAFE, "");

const sendInput = z.strictObject({
  userId: z.string().min(1),
  template: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  attachQrOf: z.strictObject({ entity: z.string().min(1), id: z.string().min(1) }).optional(),
  idempotencyKey: z.string().optional(),
});

async function sendTemplate(ctx: ConnectorCtx, input: z.infer<typeof sendInput>) {
  requireTestMode(ctx);
  const config = ctx.integration.config as EmailConfig;
  const tpl = config.templates?.[input.template];
  if (!tpl) throw new ConnectorError("CONFIG_INVALID", `Шаблон письма «${input.template}» не найден`);
  const to = await ctx.users.contact(input.userId, "email");
  if (!to) throw new ConnectorError("RECIPIENT_UNAVAILABLE", "У получателя нет адреса email");
  if (input.attachQrOf) {
    const owner = entityOf(ctx.system.spec, input.attachQrOf.entity)?.ownerField;
    const row = owner ? await ctx.db.get(input.attachQrOf.entity, input.attachQrOf.id) : null;
    if (!row || row[owner as string] !== input.userId) {
      throw new ConnectorError("INVALID_REQUEST", "QR-код можно приложить только к письму владельцу записи");
    }
  }
  const hostname = new URL(
    /^https?:\/\//.test(ctx.system.host) ? ctx.system.host : `https://${ctx.system.host}`,
  ).hostname;
  const messageId = `<${randomUUID()}@${hostname}>`;
  const headers: Record<string, string> = {
    Subject: headerSafe(render(tpl.subject, input.params, headerSafe)),
    "Auto-Submitted": "auto-generated",
    "Message-ID": messageId,
  };
  if (config.from) headers.From = `${headerSafe(config.from.name)} <${config.from.address}>`;
  if (config.replyTo) headers["Reply-To"] = headerSafe(config.replyTo);
  await ctx.outbox.write(
    outboxMessage(ctx, "email", "sendTemplate", {
      to,
      template: input.template,
      headers,
      text: render(tpl.body, input.params, (s) => s),
      html: render(escapeHtml(tpl.body), input.params, escapeHtml),
      attachQrOf: input.attachQrOf ?? null,
    }),
  );
  return { messageId };
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
