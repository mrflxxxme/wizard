// Telegram connector: specs/connectors/telegram.yaml. M0 — config/G0 and a test-mode sendToUser into the outbox.
import type { AppSpec } from "@wizard/appspec";
import { detect } from "@wizard/pii";
import { z } from "zod";
import { defineAction, defineConnector } from "./define.js";
import { ConnectorError } from "./errors.js";
import { outboxMessage, requireTestMode } from "./runtime.js";
import { hasDeclaredSecret, Issues } from "./spec-util.js";
import type { ConnectorCtx, SpecCheckContext } from "./types.js";

export const telegramConfigSchema = z
  .strictObject({
    bot: z.enum(["platform", "own"]).optional(),
    botUsername: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/, { error: "Имя бота — 5–32 символа: латиница, цифры и _, без @" })
      .optional(),
    loginEnabled: z.boolean().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.bot === "platform" && c.botUsername !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["botUsername"],
        message: "Имя бота задаётся только для своего бота (bot: own)",
      });
    }
    if (c.bot === "own" && c.botUsername === undefined) {
      ctx.addIssue({ code: "custom", path: ["botUsername"], message: "Для своего бота укажите его имя" });
    }
  });
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

export function telegramBot(config: TelegramConfig): "platform" | "own" {
  return config.bot ?? (config.botUsername ? "own" : "platform");
}

export function telegramLoginEnabled(config: TelegramConfig, spec: AppSpec): boolean {
  return config.loginEnabled ?? spec.roles.some((r) => r.loginMethods?.includes("telegram"));
}

export function validateTelegramSpec(config: TelegramConfig, spec: AppSpec, at: SpecCheckContext) {
  const issues = new Issues(at);
  const bot = telegramBot(config);
  if (bot === "platform" && telegramLoginEnabled(config, spec)) {
    issues.add(
      "telegram.login_needs_own_bot",
      config.loginEnabled === undefined ? [] : ["loginEnabled"],
      "Для входа через Telegram нужен свой бот",
    );
  }
  if (bot === "own" && !hasDeclaredSecret(at, "telegram_bot_token")) {
    issues.add(
      "telegram.bot_token_secret",
      [],
      "Для своего бота нужен токен: объявите secret://telegram_bot_token в secretRefs",
    );
  }
  return issues.list;
}

const APP_NAME_MAX = 60;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function systemOrigin(host: string): URL {
  return new URL(/^https?:\/\//.test(host) ? host : `https://${host}`);
}

const sendInput = z.strictObject({
  userId: z.string().min(1),
  text: z.string().min(1).max(4096),
  buttons: z
    .array(z.strictObject({ text: z.string().min(1).max(64), url: z.string().min(1).max(2048) }))
    .max(3)
    .optional(),
  idempotencyKey: z.string().optional(),
});
const sendOutput = z.object({
  delivered: z.boolean(),
  reason: z.enum(["not_linked", "blocked", "test_mode"]).optional(),
});

async function sendToUser(
  ctx: ConnectorCtx,
  input: z.infer<typeof sendInput>,
): Promise<z.infer<typeof sendOutput>> {
  requireTestMode(ctx);
  if (detect(input.text).length > 0) {
    throw new ConnectorError(
      "PII_BLOCKED",
      "В сообщении Telegram есть персональные данные — отправка запрещена",
    );
  }
  const origin = systemOrigin(ctx.system.host);
  const buttons = (input.buttons ?? []).map((b) => {
    const url = new URL(b.url, origin);
    if (url.host !== origin.host) {
      throw new ConnectorError("INVALID_REQUEST", "Кнопки могут вести только на страницы системы");
    }
    return { text: b.text, url: url.toString() };
  });
  const chat = await ctx.users.contact(input.userId, "telegram_chat");
  if (!chat) return { delivered: false, reason: "not_linked" };
  const config = ctx.integration.config as TelegramConfig;
  const bot = telegramBot(config);
  const prefix =
    bot === "platform"
      ? `${[...ctx.system.spec.app.name.replace(/[\r\n]+/g, " ")].slice(0, APP_NAME_MAX).join("")}: `
      : "";
  const text = escapeHtml(prefix + input.text);
  await ctx.outbox.write(
    outboxMessage(ctx, "telegram", "sendToUser", {
      userId: input.userId,
      bot,
      text,
      parse_mode: "HTML",
      buttons,
    }),
  );
  return { delivered: true, reason: "test_mode" };
}

export const telegramConnector = defineConnector({
  id: "telegram",
  milestone: "M1",
  configSchema: telegramConfigSchema,
  secrets: [
    {
      name: "telegram_bot_token",
      required: false,
      label: "Токен бота из @BotFather (обязателен при bot=own — validateSpec)",
    },
    {
      name: "telegram_webhook_secret",
      required: false,
      label: "Секрет вебхука (генерирует платформа, 32 символа A-Za-z0-9_-; при bot=own)",
    },
  ],
  validateSpec: validateTelegramSpec,
  actions: {
    sendToUser: defineAction({
      input: sendInput,
      output: sendOutput,
      effect: true,
      retry: { attempts: 3, baseMs: 1000 },
      handler: sendToUser,
    }),
  },
  testMode: (env) => (env === "draft" ? "test" : "live"),
  piiFields: ["text", "chat_id"],
});
