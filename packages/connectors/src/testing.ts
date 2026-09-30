// In-memory host doubles for tests and G1 mocks (@wizard/connectors/testing).
import { randomUUID } from "node:crypto";
import type { AppSpec, Integration } from "@wizard/appspec";
import { UniqueViolation } from "./errors.js";
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
  Row,
  SystemDb,
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
  return {
    system: { id: systemId, env, host: o.host ?? `${systemId}--${env}.localhost:4100`, spec: o.spec },
    integration: { name: integ.name, config },
    secrets,
    mode: connector.testMode(env, config, secrets),
    idempotencyKey: o.idempotencyKey ?? randomUUID(),
    users: { contact: async (userId, kind) => o.contacts?.[userId]?.[kind] ?? null },
    db: o.db ?? new MemorySystemDb(o.spec),
    log: createConnectorLogger(
      { system: systemId, env, integration: integ.name, connector: connector.id },
      (e) => logs.push(e),
    ),
    fetch: () => Promise.reject(new Error("network is disabled in tests")),
    store: o.store ?? new MemoryStore(now),
    outbox: o.outbox ?? new MemoryOutbox(),
    now,
    logs,
  };
}
