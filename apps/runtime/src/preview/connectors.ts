// Host side of connectors (specs/connectors/connector-interface.md §1): ConnectorCtx for a loaded system —
// SystemDb over DataAccess (__system), a KV store in _w_connector_calls, secrets, outbox, logger.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec, Integration } from "@wizard/appspec";
import {
  type ConnectorCtx,
  ConnectorError,
  type OutboxMessage as ConnectorOutboxMessage,
  type ConnectorStore,
  type ContactKind,
  createConnectorLogger,
  envSecretReader,
  getConnector,
  newQrKeyring,
  parseQrKeyring,
  QR_SECRET,
  type QrConfig,
  type Row,
  type SecretReader,
  type SystemDb,
  serializeQrKeyring,
  signQrToken,
  UniqueViolation,
} from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import type { DbAdapter } from "@wizard/sdk/host";
import { type DataAccess, SYSTEM_SUBJECT } from "../data/access.js";
import { isLocalMode, type RuntimeEnv } from "../env.js";
import type { OutboxMessage } from "../http/context.js";
import type { RegistryEntry, SystemEnv } from "../registry.js";

export type SecretsFactory = (systemId: string, env: SystemEnv) => SecretReader;

export interface ConnectorHostOptions {
  env: RuntimeEnv;
  clock: () => Date;
  outbox: OutboxMessage[];
  /** Default: `.env` WIZARD_SECRET_<SYSTEMID>_<NAME>, plus a generated dev QR key for local drafts. */
  secrets?: SecretsFactory;
  /** Where the generated dev QR keys live (default: <artifactsRoot>/../secrets). */
  devSecretsDir: string;
  log?: (line: Record<string, unknown>) => void;
}

/** The parts of LoadedSystem a connector context needs. */
export interface ConnectorSystem {
  entry: RegistryEntry;
  spec: AppSpec;
  data: DataAccess;
}

export interface ConnectorHost {
  /** Context of one integration; `host` is the Host header of the request (with port). */
  ctx(sys: ConnectorSystem, integration: Integration, host?: string): ConnectorCtx;
  /** Integrations of the system with the given connector id. */
  integrations(spec: AppSpec, connector: string): Integration[];
  /** qr_token issuer for DataAccess (connectors/qr.yaml#token): signed payload for the qr integration's field. */
  qrTokenIssuer(
    entry: RegistryEntry,
    spec: AppSpec,
  ): (entity: string, field: string) => Promise<string | undefined>;
}

const STORE_TTL_FOREVER = 100 * 365 * 24 * 60 * 60_000;

/** SystemDb over DataAccess: each call is one READ COMMITTED transaction as `__system`. */
export function systemDbOf(data: DataAccess): SystemDb {
  const run = <T>(fn: (db: DbAdapter) => Promise<T>) =>
    data.transaction("default", SYSTEM_SUBJECT, (tx) => fn(tx.system));
  return {
    get: (entity, id) => run((db) => db.get(entity, id)) as Promise<Row | null>,
    getBy: (entity, field, value) => run((db) => db.getBy(entity, field, value)) as Promise<Row | null>,
    list: (entity, opts = {}) =>
      run((db) =>
        db.list(entity, { where: opts.where, order: "asc", limit: Math.min(opts.limit ?? 1000, 1000) }),
      ) as Promise<Row[]>,
    async insert(entity, doc) {
      try {
        return await run((db) => db.insert(entity, doc));
      } catch (e) {
        if (e instanceof WizardError && e.code === "CONFLICT") {
          const field = (e.details.fields as { field?: string }[] | undefined)?.[0]?.field ?? "";
          throw new UniqueViolation(entity, field);
        }
        throw e;
      }
    },
    patch: (entity, id, patch) => run((db) => db.patch(entity, id, patch)),
  };
}

/** ConnectorStore in _w_connector_calls: key `kv:<integration>:<key>`, value and expiry in `result`. */
export function pgConnectorStore(data: DataAccess, integration: string, now: () => Date): ConnectorStore {
  const id = (key: string) => `kv:${integration}:${key}`;
  return {
    get: <T>(key: string) =>
      data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        const rows = await tx.sql`
          select result from ${tx.sql(data.schema)}.${tx.sql("_w_connector_calls")}
          where idempotency_key = ${id(key)}`;
        const r = rows[0]?.result as { value: unknown; until: number } | undefined;
        if (!r || r.until < now().getTime()) return undefined;
        return r.value as T;
      }),
    set: (key, value, ttlMs = STORE_TTL_FOREVER) =>
      data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        const result = { value, until: now().getTime() + Math.min(ttlMs, STORE_TTL_FOREVER) };
        await tx.sql`
          insert into ${tx.sql(data.schema)}.${tx.sql("_w_connector_calls")} (idempotency_key, integration, action, status, result)
          values (${id(key)}, ${integration}, 'kv', 'stored', ${tx.sql.json(result as never)})
          on conflict (idempotency_key) do update set result = excluded.result, status = excluded.status`;
      }),
  };
}

const CONTACT_COLUMN: Record<ContactKind, string> = {
  email: "email",
  phone: "phone",
  telegram_chat: "telegram_chat_id",
};

function contacts(data: DataAccess) {
  return {
    contact: (userId: string, kind: ContactKind) =>
      data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        const rows = await tx.sql`
          select ${tx.sql(CONTACT_COLUMN[kind])} as v from ${tx.sql(data.schema)}.${tx.sql("users")}
          where id = ${userId} and blocked_at is null`;
        const v = rows[0]?.v;
        return v === null || v === undefined ? null : String(v);
      }),
  };
}

/**
 * Local drafts without WIZARD_SECRET_<SYSTEMID>_QR_SIGNING_KEY get a generated keyring stored in
 * `<dir>/<systemId>.json` (0600), so tickets survive restarts (docs/reviews/impl-notes/M0-24.md).
 */
export function devQrSecretReader(inner: SecretReader, dir: string, systemId: string): SecretReader {
  return {
    async get(name) {
      try {
        return await inner.get(name);
      } catch (e) {
        if (name !== QR_SECRET || !(e instanceof ConnectorError) || e.code !== "SECRET_MISSING") throw e;
        if (!/^[a-z0-9]{1,64}$/.test(systemId)) throw e;
        const file = join(dir, `${systemId}.json`);
        if (existsSync(file)) {
          const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
          if (typeof stored[QR_SECRET] === "string") return stored[QR_SECRET];
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const value = serializeQrKeyring(newQrKeyring());
        writeFileSync(file, JSON.stringify({ [QR_SECRET]: value }), { mode: 0o600, flag: "wx" });
        chmodSync(file, 0o600);
        return value;
      }
    },
  };
}

export function createConnectorHost(o: ConnectorHostOptions): ConnectorHost {
  const readers = new Map<string, SecretReader>();
  const secretsOf = (systemId: string, env: SystemEnv): SecretReader => {
    const k = `${systemId}:${env}`;
    let r = readers.get(k);
    if (!r) {
      r = o.secrets?.(systemId, env) ?? envSecretReader(systemId);
      if (!o.secrets && env === "draft" && isLocalMode(o.env))
        r = devQrSecretReader(r, o.devSecretsDir, systemId);
      readers.set(k, r);
    }
    return r;
  };

  function ctx(sys: ConnectorSystem, integ: Integration, host?: string): ConnectorCtx {
    const connector = getConnector(integ.connector);
    if (!connector) throw new ConnectorError("INVALID_REQUEST", `Неизвестный коннектор «${integ.connector}»`);
    const { entry, spec, data } = sys;
    const config = connector.configSchema.parse(integ.config ?? {});
    const secrets = secretsOf(entry.systemId, entry.env);
    const base = { system: entry.systemId, env: entry.env, integration: integ.name, connector: connector.id };
    return {
      system: {
        id: entry.systemId,
        env: entry.env,
        host: host ?? `${entry.slug}--${entry.env}.${o.env.systemsDomain}`,
        spec,
      },
      integration: { name: integ.name, config },
      secrets,
      mode: connector.testMode(entry.env, config, secrets),
      idempotencyKey: randomUUID(),
      users: contacts(data),
      db: systemDbOf(data),
      log: createConnectorLogger(base, (line) => o.log?.({ level: "info", msg: "connector", ...line })),
      fetch: () => Promise.reject(new ConnectorError("EGRESS_DISABLED", "Внешние запросы недоступны в M0")),
      store: pgConnectorStore(data, integ.name, o.clock),
      outbox: {
        async write(m: ConnectorOutboxMessage) {
          const userId = typeof m.payload.userId === "string" ? m.payload.userId : null;
          o.outbox.push({
            integration: m.integration,
            action: m.action,
            userId,
            payload: m.payload,
            at: m.ts,
          });
        },
      },
      now: o.clock,
    };
  }

  const integrations = (spec: AppSpec, connector: string) =>
    (spec.integrations ?? []).filter((i) => i.connector === connector);

  return {
    ctx,
    integrations,
    // Same signing as issueQrToken(ctx); DataAccess is not needed (and not yet built) at this point.
    qrTokenIssuer(entry, spec) {
      return async (entity, field) => {
        const integ = integrations(spec, "qr").find((i) => {
          const c = i.config as Partial<QrConfig> | undefined;
          return c?.entity === entity && c.tokenField === field;
        });
        if (!integ) return undefined;
        const ring = parseQrKeyring(await secretsOf(entry.systemId, entry.env).get(QR_SECRET));
        return signQrToken(ring, { systemId: entry.systemId, env: entry.env });
      };
    },
  };
}
