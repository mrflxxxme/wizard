// Connector contract: specs/connectors/connector-interface.md §1.
import type { AppSpec, Integration } from "@wizard/appspec";
import type { z } from "zod";

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

export interface ConnectorCtx {
  system: { id: string; env: Env; host: string; spec: AppSpec };
  integration: { name: string; config: unknown };
  secrets: SecretReader;
  mode: Mode;
  idempotencyKey: string;
  users: { contact(userId: string, kind: ContactKind): Promise<string | null> };
  db: SystemDb;
  log: ConnectorLogger;
  fetch: typeof fetch;
  /** Additions to the spec'd ctx (see docs/reviews/impl-notes/M0-28.md). */
  store: ConnectorStore;
  outbox: Outbox;
  now(): Date;
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
