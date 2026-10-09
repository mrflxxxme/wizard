// In-memory host doubles for tests and G1 mocks (@wizard/connectors/testing).
import { randomUUID } from "node:crypto";
import type { AppSpec, Integration } from "@wizard/appspec";
import { UniqueViolation } from "./errors.js";
import { QR_REVOKED_PREFIX, type QrConfig } from "./qr.js";
import type { QrOfflineStore, QrSyncResult } from "./qr-offline.js";
import { getConnector } from "./registry.js";
import { createConnectorLogger, MemoryOutbox } from "./runtime.js";
import { staticSecretReader } from "./secrets.js";
import { isUniqueField } from "./spec-util.js";
import type {
  ConnectorCtx,
  ConnectorLogEntry,
  ConnectorStore,
  ContactKind,
  Env,
  PlatformConnectorConfig,
  Row,
  SecretReader,
  SystemDb,
  TelegramLinkStore,
} from "./types.js";

/** SystemDb over maps; enforces `unique` fields of the spec. */
export class MemorySystemDb implements SystemDb {
  readonly tables = new Map<string, Map<string, Row>>();
  constructor(private readonly spec: AppSpec) {}

  private table(entity: string): Map<string, Row> {
    let t = this.tables.get(entity);
    if (!t) {
      t = new Map();
      this.tables.set(entity, t);
    }
    return t;
  }

  private checkUnique(entity: string, doc: Record<string, unknown>, selfId?: string): void {
    const e = this.spec.entities.find((x) => x.name === entity);
    for (const f of e?.fields ?? []) {
      const v = doc[f.name];
      if (v === undefined || v === null || !isUniqueField(e as NonNullable<typeof e>, f.name)) continue;
      for (const row of this.table(entity).values()) {
        if (row.id !== selfId && row[f.name] === v) throw new UniqueViolation(entity, f.name);
      }
    }
  }

  async get(entity: string, id: string) {
    const r = this.table(entity).get(id);
    return r ? { ...r } : null;
  }
  async getBy(entity: string, field: string, value: unknown) {
    for (const r of this.table(entity).values()) if (r[field] === value) return { ...r };
    return null;
  }
  async list(entity: string, opts: { where?: Record<string, unknown>; limit?: number } = {}) {
    const where = Object.entries(opts.where ?? {});
    return [...this.table(entity).values()]
      .filter((r) => where.every(([k, v]) => r[k] === v))
      .slice(0, opts.limit ?? Number.POSITIVE_INFINITY)
      .map((r) => ({ ...r }));
  }
  async insert(entity: string, doc: Record<string, unknown>) {
    this.checkUnique(entity, doc);
    const id = typeof doc.id === "string" ? doc.id : randomUUID();
    this.table(entity).set(id, { ...doc, id });
    return id;
  }
  async patch(entity: string, id: string, patch: Record<string, unknown>) {
    const row = this.table(entity).get(id);
    if (!row) throw new Error(`row ${entity}/${id} not found`);
    this.checkUnique(entity, { ...row, ...patch }, id);
    this.table(entity).set(id, { ...row, ...patch, id });
  }
}

export class MemoryStore implements ConnectorStore {
  readonly data = new Map<string, { value: unknown; until: number }>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.data.get(key);
    if (!hit || hit.until < this.now().getTime()) return undefined;
    return structuredClone(hit.value) as T;
  }
  async set(key: string, value: unknown, ttlMs = Number.POSITIVE_INFINITY) {
    this.data.set(key, { value: structuredClone(value), until: this.now().getTime() + ttlMs });
  }
  async setIfAbsent(key: string, value: unknown, ttlMs = Number.POSITIVE_INFINITY) {
    const hit = this.data.get(key);
    if (hit && hit.until >= this.now().getTime()) return false;
    this.data.set(key, { value: structuredClone(value), until: this.now().getTime() + ttlMs });
    return true;
  }
}

/**
 * QrOfflineStore over MemorySystemDb/MemoryStore. `since` is ignored (memory rows have no timestamps): deltas
 * equal the full package here; the runtime tests cover them against Postgres.
 */
export class MemoryQrOfflineStore implements QrOfflineStore {
  readonly qrEvents = new Map<
    string,
    { deviceId: string; result: QrSyncResult; clockSkew: boolean; receivedAt: Date }
  >();
  readonly devices = new Map<string, { userId: string | null; pending: number; lastSyncAt: Date }>();
  constructor(
    private readonly db: MemorySystemDb,
    private readonly store: MemoryStore,
    private readonly config: QrConfig,
  ) {}
  async carriers() {
    return this.db.list(this.config.entity);
  }
  async checkedInTokens() {
    const out: string[] = [];
    for (const c of await this.db.list(this.config.checkin.entity)) {
      const t = await this.db.get(this.config.entity, String(c[this.config.checkin.refField]));
      if (typeof t?.[this.config.tokenField] === "string") out.push(t[this.config.tokenField] as string);
    }
    return out;
  }
  async revokedHashes() {
    const out: string[] = [];
    for (const k of this.store.data.keys()) {
      if (k.startsWith(QR_REVOKED_PREFIX) && (await this.store.get(k)) !== undefined)
        out.push(k.slice(QR_REVOKED_PREFIX.length));
    }
    return out;
  }
  async events(ids: readonly string[]) {
    const out = new Map<string, QrSyncResult>();
    for (const id of ids) {
      const e = this.qrEvents.get(id);
      if (e) out.set(id, e.result);
    }
    return out;
  }
  async saveEvent(e: Parameters<QrOfflineStore["saveEvent"]>[0]) {
    const hit = this.qrEvents.get(e.clientEventId);
    if (hit) return hit.result;
    this.qrEvents.set(e.clientEventId, e);
    return e.result;
  }
  async saveDevice(d: Parameters<QrOfflineStore["saveDevice"]>[0]) {
    this.devices.set(d.deviceId, d);
  }
  async purgeEvents(before: Date) {
    for (const [k, e] of this.qrEvents) if (e.receivedAt < before) this.qrEvents.delete(k);
  }
}

/** _w_telegram_links in memory. */
export class MemoryTelegramLinks implements TelegramLinkStore {
  readonly links = new Map<string, { userId: string; expiresAt: Date }>();
  async create(hash: Buffer, userId: string, expiresAt: Date) {
    this.links.set(hash.toString("hex"), { userId, expiresAt });
  }
  async consume(hash: Buffer, now: Date) {
    const k = hash.toString("hex");
    const hit = this.links.get(k);
    this.links.delete(k);
    return hit && hit.expiresAt > now ? hit.userId : null;
  }
}

/** Platform settings for tests: no platform secrets unless given, network disabled. */
export function testPlatform(
  o: Partial<PlatformConnectorConfig> & { secrets?: SecretReader } = {},
): PlatformConnectorConfig {
  return {
    secrets: staticSecretReader({}),
    telegram: { apiBase: "https://api.telegram.org", botUsername: "wizard_test_bot" },
    smtp: null,
    devSmtp: null,
    mailDomain: "systems.test",
    resolve: async () => {
      throw new Error("DNS is disabled in tests");
    },
    dial: async () => {
      throw new Error("network is disabled in tests");
    },
    ...o,
  };
}

export interface TestCtxOptions {
  spec: AppSpec;
  integration: string;
  systemId?: string;
  env?: Env;
  host?: string;
  secrets?: Record<string, string>;
  contacts?: Record<string, Partial<Record<ContactKind, string>>>;
  db?: SystemDb;
  store?: ConnectorStore;
  outbox?: MemoryOutbox;
  idempotencyKey?: string;
  now?: () => Date;
  platform?: PlatformConnectorConfig;
  fetch?: typeof fetch;
  plan?: "free" | "paid";
  telegramLinks?: TelegramLinkStore;
}

/** ConnectorCtx with in-memory doubles; `logs` collects everything the connector logged. */
export function createTestCtx(o: TestCtxOptions): ConnectorCtx & {
  logs: Partial<ConnectorLogEntry>[];
  outbox: MemoryOutbox;
} {
  const integ = o.spec.integrations?.find((i) => i.name === o.integration) as Integration | undefined;
  if (!integ) throw new Error(`integration ${o.integration} not in spec`);
  const connector = getConnector(integ.connector);
  if (!connector) throw new Error(`unknown connector ${integ.connector}`);
  const config = connector.configSchema.parse(integ.config ?? {});
  const env = o.env ?? "draft";
  const systemId = o.systemId ?? "sys_test";
  const secrets = staticSecretReader(o.secrets ?? {});
  const now = o.now ?? (() => new Date());
  const logs: Partial<ConnectorLogEntry>[] = [];
  const contacts = o.contacts ?? {};
  return {
    system: {
      id: systemId,
      env,
      host: o.host ?? `${systemId}--${env}.localhost:4100`,
      spec: o.spec,
      plan: o.plan ?? "free",
    },
    integration: { name: integ.name, config },
    secrets,
    mode: connector.testMode(env, config, secrets),
    idempotencyKey: o.idempotencyKey ?? randomUUID(),
    users: {
      contact: async (userId, kind) => contacts[userId]?.[kind] ?? null,
      async setTelegramChat(userId, chatId) {
        const c = contacts[userId] ?? {};
        contacts[userId] = c;
        if (chatId === null) delete c.telegram_chat;
        else c.telegram_chat = chatId;
      },
      async clearTelegramChat(chatId) {
        for (const c of Object.values(contacts)) if (c.telegram_chat === chatId) delete c.telegram_chat;
      },
    },
    db: o.db ?? new MemorySystemDb(o.spec),
    log: createConnectorLogger(
      { system: systemId, env, integration: integ.name, connector: connector.id },
      (e) => logs.push(e),
    ),
    fetch: o.fetch ?? (() => Promise.reject(new Error("network is disabled in tests"))),
    store: o.store ?? new MemoryStore(now),
    outbox: o.outbox ?? new MemoryOutbox(),
    now,
    platform: o.platform ?? testPlatform(),
    telegramLinks: o.telegramLinks ?? new MemoryTelegramLinks(),
    logs,
  };
}
