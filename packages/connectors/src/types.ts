// Connector contract: specs/connectors/connector-interface.md §1.
import type { AppSpec, Integration } from "@wizard/appspec";
import type { z } from "zod";
import type { Dialer, Resolver } from "./net.js";
import type { SmtpEndpoint } from "./smtp.js";

export type ConnectorId = "yookassa" | "telegram" | "email" | "qr";
export type Env = "draft" | "prod";
export type Mode = "test" | "live";

/** G0 finding about one integration (JSON Pointer into the spec). */
export interface SpecIssue {
  code: "SCHEMA_INVALID" | "CONFIG_INVALID";
  path: string;
  message_ru: string;
  /** Stable rule id, e.g. `yookassa.binding.amount_field_type`. */
  rule: string;
  allowed?: string[];
}

/** Where validateSpec is looking: the integration and the JSON Pointer segments of its `config`. */
export interface SpecCheckContext {
  integration: Integration;
  base: readonly (string | number)[];
}

export interface SecretReader {
  /** Throws ConnectorError SECRET_MISSING when the value is absent. */
  get(name: string): Promise<string>;
}

export type Row = Record<string, unknown> & { id: string };

/** Host-side system access (ctx.systemDb): wizard.role='__system', no row filters. */
export interface SystemDb {
  get(entity: string, id: string): Promise<Row | null>;
  getBy(entity: string, field: string, value: unknown): Promise<Row | null>;
  list(entity: string, opts?: { where?: Record<string, unknown>; limit?: number }): Promise<Row[]>;
  /** Throws UniqueViolation on a unique constraint conflict. */
  insert(entity: string, doc: Record<string, unknown>): Promise<string>;
  patch(entity: string, id: string, patch: Record<string, unknown>): Promise<void>;
}

/** Per-integration key-value state with TTL (backs _w_connector_calls, payment metadata, QR revocations). */
export interface ConnectorStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

export interface OutboxMessage {
  ts: string;
  system: string;
  env: Env;
  connector: ConnectorId;
  integration: string;
  action: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Dev receiver for test-mode effects (.data/outbox/<system>/<connector>.jsonl). */
export interface Outbox {
  write(message: OutboxMessage): Promise<void>;
}

export interface ConnectorLogEntry {
  ts: string;
  system: string;
  env: Env;
  integration: string;
  connector: ConnectorId;
  action: string;
  mode: Mode;
  status: string;
  errorCode?: string;
  providerStatus?: number;
  providerCode?: string;
  durationMs: number;
  idempotencyKey: string;
}

export interface ConnectorLogger {
  /** Only allowlisted fields are kept (connector-interface.md §2 «Логи без ПДн»). */
  log(entry: Partial<ConnectorLogEntry>): void;
}

export type ContactKind = "email" | "phone" | "telegram_chat";

/** Host-side access to the system's users table (addresses never reach system code). */
export interface ConnectorUsers {
  contact(userId: string, kind: ContactKind): Promise<string | null>;
  /** Sets or clears users.telegram_chat_id (chat linking, 403 blocked, my_chat_member kicked). */
  setTelegramChat(userId: string, chatId: string | null): Promise<void>;
  /** Clears telegram_chat_id of every user of this system linked to `chatId`. */
  clearTelegramChat(chatId: string): Promise<void>;
}

/** One-time deep-link tokens (runtime.yaml _w_telegram_links): stored as sha256 with the user id. */
export interface TelegramLinkStore {
  create(tokenHash: Buffer, userId: string, expiresAt: Date): Promise<void>;
  /** Deletes the token and returns its user when it exists and has not expired. */
  consume(tokenHash: Buffer, now: Date): Promise<string | null>;
}

/** Platform-owned settings and secrets (not the system's): shared Telegram bot, platform SMTP, network access. */
export interface PlatformConnectorConfig {
  /** telegram_bot_token, telegram_webhook_secret, smtp_password of the platform (WIZARD_* env in M1). */
  secrets: SecretReader;
  telegram: { apiBase: string; botUsername: string | null };
  /** Platform SMTP account (email provider=platform); null — not configured yet (E-ACCESS). */
  smtp: SmtpEndpoint | null;
  /** Local dev receiver for test-mode mail (WIZARD_DEV_SMTP=1); null — the outbox. */
  devSmtp: SmtpEndpoint | null;
  /** Sender domain of provider=platform: noreply@<mailDomain>. */
  mailDomain: string;
  /** DNS and TCP for SMTP (tests substitute both); TLS trusts `tlsCa` in addition to the system store. */
  resolve: Resolver;
  dial: Dialer;
  tlsCa?: string;
  /** YooKassa API transport; absent — defaults (no network: the draft mock payment only). */
  yookassa?: YookassaPlatformConfig;
}

/** Platform-side YooKassa settings (yookassa.yaml#api, #webhooks.verification). */
export interface YookassaPlatformConfig {
  /** WIZARD_CONNECTORS=live: real API calls with the shop's keys; otherwise the draft mock flow. */
  live: boolean;
  /** https://api.yookassa.ru/v3 (WIZARD_YOOKASSA_API_BASE for stubs). */
  apiBase: string;
  /** Source CIDRs of HTTP notifications (WIZARD_YOOKASSA_IP_ALLOWLIST overrides the built-in list). */
  ipAllowlist: readonly string[];
}

export interface ConnectorCtx {
  system: {
    id: string;
    env: Env;
    host: string;
    spec: AppSpec;
    /** Tariff class for connector limits (billing.yaml#plans); default free. */
    plan?: "free" | "paid";
  };
  integration: { name: string; config: unknown };
  secrets: SecretReader;
  mode: Mode;
  idempotencyKey: string;
  users: ConnectorUsers;
  db: SystemDb;
  log: ConnectorLogger;
  fetch: typeof fetch;
  /** Additions to the spec'd ctx (see docs/reviews/impl-notes/M0-28.md). */
  store: ConnectorStore;
  outbox: Outbox;
  now(): Date;
  platform: PlatformConnectorConfig;
  telegramLinks: TelegramLinkStore;
}

export interface ActionDef<I, O> {
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  effect: boolean;
  retry: { attempts: number; baseMs: number } | null;
  handler(ctx: ConnectorCtx, input: I): Promise<O>;
}

export interface WebhookDef {
  name: string;
  verify(req: Request, ctx: ConnectorCtx): Promise<boolean>;
  handle(req: Request, ctx: ConnectorCtx): Promise<{ status: number }>;
}

export interface SecretDecl {
  name: string;
  required: boolean;
  label: string;
}

// biome-ignore lint/suspicious/noExplicitAny: action map is heterogeneous; handlers are typed per action
export type AnyAction = ActionDef<any, any>;

export interface ConnectorDefinition<Config, Actions extends Record<string, AnyAction>> {
  id: ConnectorId;
  milestone: "M0" | "M1" | "M2";
  configSchema: z.ZodType<Config>;
  secrets: readonly SecretDecl[];
  validateSpec?(config: Config, spec: AppSpec, at: SpecCheckContext): SpecIssue[];
  actions: Actions;
  webhooks?: WebhookDef[];
  testMode(env: Env, config: Config, secrets: SecretReader): Mode;
  piiFields: readonly string[];
}

// biome-ignore lint/suspicious/noExplicitAny: registry holds heterogeneous connector configs
export type AnyConnector = ConnectorDefinition<any, Record<string, AnyAction>>;
