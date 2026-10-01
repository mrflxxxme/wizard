// Telegram connector: specs/connectors/telegram.yaml — shared platform bot by default, own bot for login.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { detect } from "@wizard/pii";
import { z } from "zod";
import { defineAction, defineConnector } from "./define.js";
import { ConnectorError, isConnectorError } from "./errors.js";
import { consumeQuota, outboxMessage } from "./runtime.js";
import { hasDeclaredSecret, Issues } from "./spec-util.js";
import { botCall, derivedToken } from "./telegram-api.js";
import { checkRecipient, checkTelegramText, notifySteps } from "./templates.js";
import type { ConnectorCtx, Env, PlatformConnectorConfig, SpecCheckContext } from "./types.js";

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
  for (const step of notifySteps(spec, at.integration.name)) {
    issues.list.push(...checkRecipient(step, "telegram"), ...checkTelegramText(spec, step));
  }
  return issues.list;
}

// ------------------------------------------------------------------------------------------------
// sending

const APP_NAME_MAX = 60;
const DAY_MS = 24 * 60 * 60_000;
/** bots.platform.limits: ≤ 1 message/s per system on average, Free ≤ 500/day. */
const PLATFORM_PER_MINUTE = 60;
const PLATFORM_FREE_PER_DAY = 500;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function systemOrigin(host: string): URL {
  return new URL(/^https?:\/\//.test(host) ? host : `https://${host}`);
}

/** app.name without line breaks, ≤ 60 code points (bots.platform.prefix). */
export function appLabel(spec: AppSpec): string {
  return [...spec.app.name.replace(/[\r\n]+/g, " ")].slice(0, APP_NAME_MAX).join("");
}

function configOf(ctx: ConnectorCtx): TelegramConfig {
  return ctx.integration.config as TelegramConfig;
}

/** Token of the bot this integration sends with: the platform's shared bot or the client's own one. */
export async function telegramBotToken(ctx: ConnectorCtx): Promise<string> {
  return telegramBot(configOf(ctx)) === "platform"
    ? ctx.platform.secrets.get("telegram_bot_token")
    : ctx.secrets.get("telegram_bot_token");
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
  const bot = telegramBot(configOf(ctx));
  const prefix = bot === "platform" ? `${appLabel(ctx.system.spec)}: ` : "";
  const text = escapeHtml(prefix + input.text);
  if (ctx.mode === "test") {
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
  if (bot === "platform") {
    await consumeQuota(
      ctx,
      "telegram_platform_minute",
      PLATFORM_PER_MINUTE,
      60_000,
      "Слишком много уведомлений Telegram — не больше одного в секунду",
    );
    if ((ctx.system.plan ?? "free") === "free") {
      await consumeQuota(
        ctx,
        "telegram_platform_day",
        PLATFORM_FREE_PER_DAY,
        DAY_MS,
        "На тарифе Free — не больше 500 уведомлений Telegram в сутки",
      );
    }
  }
  const token = await telegramBotToken(ctx);
  const body: Record<string, unknown> = {
    chat_id: chat,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
  if (buttons.length)
    body.reply_markup = { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] };
  try {
    await botCall(ctx.fetch, ctx.platform.telegram.apiBase, token, "sendMessage", body);
  } catch (e) {
    if (isConnectorError(e) && e.code === "RECIPIENT_UNAVAILABLE") {
      await ctx.users.setTelegramChat(input.userId, null);
      return { delivered: false, reason: "blocked" };
    }
    throw e;
  }
  return { delivered: true };
}

// ------------------------------------------------------------------------------------------------
// chat linking (telegram.yaml#chat_linking)

export const LINK_TTL_MS = DAY_MS;
const LINK_RE = /^[A-Za-z0-9_-]{32}$/;
const ENV_CHAR: Record<Env, string> = { draft: "d", prod: "p" };

export function linkTokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * One-time deep-link token (32 chars). For the shared bot it starts with `<systemId><d|p>` so the platform webhook
 * can route it to the system; the rest is random (≥ 114 bits).
 */
export function newLinkToken(ctx: Pick<ConnectorCtx, "system" | "integration">): string {
  const shared = telegramBot(ctx.integration.config as TelegramConfig) === "platform";
  const prefix = shared ? `${ctx.system.id}${ENV_CHAR[ctx.system.env]}` : "";
  return (prefix + randomBytes(24).toString("base64url")).slice(0, 32);
}

/** System addressed by a shared-bot link token, or null. */
export function platformLinkTarget(token: string): { systemId: string; env: Env } | null {
  const m = /^([a-z0-9]{12})([dp])[A-Za-z0-9_-]{19}$/.exec(token);
  if (!m) return null;
  return { systemId: m[1] as string, env: m[2] === "p" ? "prod" : "draft" };
}

/** POST /api/telegram/:integration/link → {url}: t.me deep link for the signed-in user (TTL 24 h). */
export async function createTelegramLink(ctx: ConnectorCtx, userId: string): Promise<{ url: string }> {
  const config = configOf(ctx);
  const username =
    telegramBot(config) === "platform" ? ctx.platform.telegram.botUsername : (config.botUsername ?? null);
  if (!username) {
    throw new ConnectorError("SECRET_MISSING", "Бот уведомлений платформы ещё не настроен");
  }
  const token = newLinkToken(ctx);
  await ctx.telegramLinks.create(linkTokenHash(token), userId, new Date(ctx.now().getTime() + LINK_TTL_MS));
  return { url: `https://t.me/${username}?start=${token}` };
}

// ------------------------------------------------------------------------------------------------
// webhooks (telegram.yaml#webhooks)

export const WEBHOOK_BODY_MAX = 256 * 1024;
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** secret_token of the own bot's webhook: telegram_webhook_secret, or derived from the bot token when absent. */
export async function telegramWebhookSecret(ctx: ConnectorCtx): Promise<string> {
  try {
    return await ctx.secrets.get("telegram_webhook_secret");
  } catch (e) {
    if (!isConnectorError(e) || e.code !== "SECRET_MISSING") throw e;
    return derivedToken(await ctx.secrets.get("telegram_bot_token"), "telegram-webhook-secret");
  }
}

/** <hookToken> of /_wizard/hooks/telegram/<integration>/<hookToken> (derived, no storage). */
export async function telegramHookToken(ctx: ConnectorCtx): Promise<string> {
  return derivedToken(await telegramWebhookSecret(ctx), `hook:${ctx.integration.name}`);
}

/** <hookToken> of the shared bot's webhook /_wizard/hooks/telegram/_platform/<hookToken>. */
export async function platformHookToken(platform: PlatformConnectorConfig): Promise<string> {
  return derivedToken(await platform.secrets.get("telegram_webhook_secret"), "hook:_platform");
}

/** Constant-time comparison of a presented secret with the expected one. */
export function secretMatches(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && presented.length === expected.length;
}

export type TelegramUpdate =
  | { updateId: number; kind: "start"; chatId: string; token: string }
  | { updateId: number; kind: "kicked"; chatId: string }
  | { updateId: number; kind: "other"; chatId: string | null };

/** Only /start <token> and my_chat_member matter (telegram.yaml#webhooks.handling). */
export function parseTelegramUpdate(body: unknown): TelegramUpdate | null {
  if (typeof body !== "object" || body === null) return null;
  const u = body as Record<string, unknown>;
  if (typeof u.update_id !== "number") return null;
  const updateId = u.update_id;
  const member = u.my_chat_member as
    | { chat?: { id?: unknown }; new_chat_member?: { status?: unknown } }
    | undefined;
  if (member) {
    const chatId = member.chat?.id;
    if (member.new_chat_member?.status === "kicked" && typeof chatId === "number") {
      return { updateId, kind: "kicked", chatId: String(chatId) };
    }
    return { updateId, kind: "other", chatId: null };
  }
  const msg = u.message as { chat?: { id?: unknown; type?: unknown }; text?: unknown } | undefined;
  const chatId = typeof msg?.chat?.id === "number" ? String(msg.chat.id) : null;
  const text = typeof msg?.text === "string" ? msg.text.trim() : "";
  const m = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text);
  if (chatId && msg?.chat?.type === "private" && m)
    return { updateId, kind: "start", chatId, token: m[1] as string };
  return { updateId, kind: "other", chatId };
}

export interface WebhookReply {
  /** Answer to Telegram in the webhook response body (method call), or null — 200 with an empty object. */
  reply: { method: "sendMessage"; chat_id: string; text: string } | null;
}

export const LINKED_TEXT = "Готово, уведомления подключены";
export const LINK_INVALID_TEXT = "Ссылка устарела или уже использована. Откройте её заново в системе.";
export const PLATFORM_OTHER_TEXT = "Этот бот присылает уведомления систем, которые вы подключили";

const reply = (chatId: string | null, text: string): WebhookReply => ({
  reply: chatId ? { method: "sendMessage", chat_id: chatId, text } : null,
});

/** Links the chat of a /start <token> to the token's user within the system of `ctx`. */
export async function linkChat(ctx: ConnectorCtx, token: string, chatId: string): Promise<WebhookReply> {
  if (!LINK_RE.test(token)) return reply(chatId, LINK_INVALID_TEXT);
  const userId = await ctx.telegramLinks.consume(linkTokenHash(token), ctx.now());
  if (!userId) return reply(chatId, LINK_INVALID_TEXT);
  await ctx.users.setTelegramChat(userId, chatId);
  ctx.log.log({ action: "link", status: "ok", mode: ctx.mode, durationMs: 0 });
  return reply(chatId, LINKED_TEXT);
}

/**
 * Own bot webhook after verification: idempotent by update_id; /start links, kicked unlinks, the rest gets the
 * auto-answer «Этот бот отправляет уведомления системы <app.name>».
 */
export async function handleTelegramUpdate(ctx: ConnectorCtx, update: TelegramUpdate): Promise<WebhookReply> {
  const seen = `tg_update:${update.updateId}`;
  if (await ctx.store.get(seen)) return { reply: null };
  await ctx.store.set(seen, true, DAY_MS);
  if (update.kind === "start") return linkChat(ctx, update.token, update.chatId);
  if (update.kind === "kicked") {
    await ctx.users.clearTelegramChat(update.chatId);
    return { reply: null };
  }
  return reply(update.chatId, `Этот бот отправляет уведомления системы ${appLabel(ctx.system.spec)}`);
}

export interface PlatformHookDeps {
  /** Connector context of the shared-bot telegram integration of that system, or null. */
  locate(target: { systemId: string; env: Env }): Promise<ConnectorCtx | null>;
  /** telegram_chat_id = NULL for this chat in every system (bots.platform.unlink). */
  clearEverywhere(chatId: string): Promise<void>;
  /** true when this update_id was already handled (idempotency across systems). */
  seen(updateId: number): boolean;
}

/** Shared bot webhook after verification: routes /start by the link token, unlinks everywhere on kicked. */
export async function handlePlatformUpdate(
  update: TelegramUpdate,
  deps: PlatformHookDeps,
): Promise<WebhookReply> {
  if (deps.seen(update.updateId)) return { reply: null };
  if (update.kind === "kicked") {
    await deps.clearEverywhere(update.chatId);
    return { reply: null };
  }
  if (update.kind === "other") return reply(update.chatId, PLATFORM_OTHER_TEXT);
  const target = platformLinkTarget(update.token);
  const ctx = target ? await deps.locate(target) : null;
  if (!ctx) return reply(update.chatId, LINK_INVALID_TEXT);
  return linkChat(ctx, update.token, update.chatId);
}

// ------------------------------------------------------------------------------------------------
// own bot management (telegram.yaml#api.methods): called by the platform on save, publish and removal

/** getMe: checks the own bot's token; returns the bot's username. */
export async function telegramGetMe(ctx: ConnectorCtx): Promise<{ id: number; username: string }> {
  return botCall(ctx.fetch, ctx.platform.telegram.apiBase, await telegramBotToken(ctx), "getMe", {});
}

/** setWebhook to https://<host>/_wizard/hooks/telegram/<integration>/<hookToken> with the secret token. */
export async function telegramSetWebhook(ctx: ConnectorCtx): Promise<void> {
  const origin = systemOrigin(ctx.system.host);
  await botCall(ctx.fetch, ctx.platform.telegram.apiBase, await telegramBotToken(ctx), "setWebhook", {
    url: `${origin.origin}/_wizard/hooks/telegram/${ctx.integration.name}/${await telegramHookToken(ctx)}`,
    secret_token: await telegramWebhookSecret(ctx),
    allowed_updates: ["message", "my_chat_member"],
  });
}

export async function telegramDeleteWebhook(ctx: ConnectorCtx): Promise<void> {
  await botCall(ctx.fetch, ctx.platform.telegram.apiBase, await telegramBotToken(ctx), "deleteWebhook", {});
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
