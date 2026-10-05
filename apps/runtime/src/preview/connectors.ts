// Host side of connectors (specs/connectors/connector-interface.md §1): ConnectorCtx for a loaded system —
// SystemDb over DataAccess (__system), a KV store in _w_connector_calls, secrets, outbox, logger; M1-06: users
// contacts/telegram chat, _w_telegram_links, platform settings (shared bot, platform SMTP), guarded fetch.
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
  DEFAULT_YOOKASSA_PLATFORM,
  envSecretReader,
  getConnector,
  guardedFetch,
  JsonlOutbox,
  type MessageJournal,
  type MessageLinks,
  newQrKeyring,
  type PlatformConnectorConfig,
  parseQrKeyring,
  platformConfigFromEnv,
  QR_SECRET,
  type QrConfig,
  type Row,
  type SecretReader,
  type SystemDb,
  serializeQrKeyring,
  signQrToken,
  staticSecretReader,
  type TelegramLinkStore,
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
  /** Shared bot, platform SMTP, dev receiver; default: platformConfigFromEnv(process.env). */
  platform?: PlatformConnectorConfig;
  /** Also write test-mode effects to <outboxDir>/<system>/<connector>.jsonl (+ email/*.eml); default: memory only. */
  outboxDir?: string | null;
  /** RuntimeAppOptions.connectors: 'live' enables YooKassa API calls (otherwise the draft mock payment). */
  connectors?: "outbox" | "live";
  /** M2-50: emails of the org owners of a system (registry: platform.system_owner_emails); default: none. */
  owners?: (systemId: string) => Promise<string[]>;
  /** M2-50: AES-GCM sealing of message links (auth keys, WIZARD_SECRETS_KEY); absent — visitor mail has no links. */
  seal?: (value: unknown, aad: string) => string;
}

/** Path of the one-time links of visitor messages (CSRF-free like connector hooks; the token segment is masked in logs). */
export const MESSAGE_LINK_PATH = "/_wizard/hooks/message";
/** Lifetime of a cancel/unsubscribe link. */
export const MESSAGE_LINK_TTL_MS = 30 * 24 * 60 * 60_000;

/** Payload of a sealed message link. */
export interface MessageLinkPayload {
  a: "cancel" | "unsubscribe";
  en: string;
  id: string;
  wf: string;
  st: number;
  exp: number;
}

/** AAD binding a message link to one deployment. */
export const messageLinkAad = (systemId: string, env: SystemEnv) => `wizard-message-link:${systemId}:${env}`;

/** The parts of LoadedSystem a connector context needs. */
export interface ConnectorSystem {
  entry: RegistryEntry;
  spec: AppSpec;
  data: DataAccess;
}

export interface ConnectorHost {
  /** Context of one integration; `host` is the Host header of the request (with port). */
  ctx(sys: ConnectorSystem, integration: Integration, host?: string): ConnectorCtx;
  /** Secrets of a deployment (secret://name of functions — ctx.http, M2-52; never exposed to system code). */
  secrets(entry: RegistryEntry): SecretReader;
  /** Context of the platform mail account for host-side mail of a system (invitations, email OTP). */
  platformMailCtx(sys: ConnectorSystem, host?: string): ConnectorCtx;
  readonly platform: PlatformConnectorConfig;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_RE = /^-?\d{1,20}$/;

const USERS_LIMIT = 200;

function contacts(data: DataAccess) {
  return {
    byRole: (role: string) =>
      data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        const rows = await tx.sql`
          select id::text as id from ${tx.sql(data.schema)}.${tx.sql("users")}
          where role = ${role} and blocked_at is null order by created_at limit ${USERS_LIMIT}`;
        return rows.map((r) => String(r.id));
      }),
    byEmail: (emails: readonly string[]) =>
      emails.length === 0
        ? Promise.resolve([])
        : data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
            const rows = await tx.sql`
              select id::text as id from ${tx.sql(data.schema)}.${tx.sql("users")}
              where lower(email) = any(${emails.map((e) => e.toLowerCase())}::text[]) and blocked_at is null
              limit ${USERS_LIMIT}`;
            return rows.map((r) => String(r.id));
          }),
    contact: (userId: string, kind: ContactKind) =>
      UUID_RE.test(userId)
        ? data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
            const rows = await tx.sql`
              select ${tx.sql(CONTACT_COLUMN[kind])} as v from ${tx.sql(data.schema)}.${tx.sql("users")}
              where id = ${userId} and blocked_at is null`;
            const v = rows[0]?.v;
            return v === null || v === undefined ? null : String(v);
          })
        : Promise.resolve(null),
    setTelegramChat: async (userId: string, chatId: string | null) => {
      if (!UUID_RE.test(userId) || (chatId !== null && !CHAT_RE.test(chatId))) return;
      await data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        await tx.sql`
          update ${tx.sql(data.schema)}.${tx.sql("users")} set telegram_chat_id = ${chatId} where id = ${userId}`;
      });
    },
    clearTelegramChat: async (chatId: string) => {
      if (!CHAT_RE.test(chatId)) return;
      await data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        await tx.sql`
          update ${tx.sql(data.schema)}.${tx.sql("users")} set telegram_chat_id = null
          where telegram_chat_id = ${chatId}`;
      });
    },
  };
}

/** _w_messages (M2-50): delivery journal without text or address; a schema without the table is skipped. */
export function pgMessageJournal(data: DataAccess): MessageJournal {
  return {
    write: (e) =>
      data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        await tx.sql`
          insert into ${tx.sql(data.schema)}.${tx.sql("_w_messages")}
            (workflow, step, integration, channel, recipient, address_hash, template, status, error_code)
          values (${e.workflow}, ${e.step}, ${e.integration}, ${e.channel}, ${e.recipient}, ${e.addressHash},
            ${e.template}, ${e.status}, ${e.errorCode})`;
      }),
  };
}

/** _w_telegram_links (runtime.yaml#postgres.system_tables): sha256 of the token, one-time, with expiry. */
export function pgTelegramLinks(data: DataAccess): TelegramLinkStore {
  return {
    create: (hash, userId, expiresAt) =>
      data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        await tx.sql`
          insert into ${tx.sql(data.schema)}.${tx.sql("_w_telegram_links")} (token_hash, user_id, expires_at)
          values (${hash}, ${userId}, ${expiresAt})`;
      }),
    consume: (hash, now) =>
      data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
        const rows = await tx.sql`
          delete from ${tx.sql(data.schema)}.${tx.sql("_w_telegram_links")} where token_hash = ${hash}
          returning user_id, expires_at`;
        const r = rows[0];
        return r && new Date(r.expires_at as string).getTime() > now.getTime() ? String(r.user_id) : null;
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

/** Test-mode secrets (G1 runtimes): one in-memory QR keyring shared by every system of the factory; nothing else. */
export function testModeSecrets(): SecretsFactory {
  const reader = staticSecretReader({ [QR_SECRET]: serializeQrKeyring(newQrKeyring()) });
  return () => reader;
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

  const base =
    o.platform ??
    platformConfigFromEnv(process.env, { systemsDomain: o.env.systemsDomain, local: isLocalMode(o.env) });
  const yookassa = {
    ...(base.yookassa ?? DEFAULT_YOOKASSA_PLATFORM),
    ...(o.connectors ? { live: o.connectors === "live" } : {}),
  };
  const platform: PlatformConnectorConfig = { ...base, yookassa };
  const files = o.outboxDir ? new JsonlOutbox(o.outboxDir) : null;
  // Provider endpoints configured by the platform itself (stubs in tests and local runs) are trusted hosts.
  const fetchGuarded = guardedFetch({
    trustedHosts: [new URL(platform.telegram.apiBase).host, new URL(yookassa.apiBase).host],
  });

  /** Canonical host of a system (runtime.yaml#routing): prod — the alias, draft — <slug>--draft. */
  const originOf = (entry: RegistryEntry, host?: string) =>
    `${o.env.publicScheme}://${host ?? (entry.env === "prod" ? `${entry.slug}.${o.env.systemsDomain}` : `${entry.slug}--draft.${o.env.systemsDomain}`)}`;

  // Owners change rarely: one lookup a minute per system.
  const ownerCache = new Map<string, { at: number; emails: Promise<string[]> }>();
  const ownersOf = (systemId: string): Promise<string[]> => {
    const owners = o.owners;
    if (!owners) return Promise.resolve([]);
    const now = Date.now();
    const hit = ownerCache.get(systemId);
    if (hit && now - hit.at < 60_000) return hit.emails;
    const emails = owners(systemId).catch(() => [] as string[]);
    ownerCache.set(systemId, { at: now, emails });
    return emails;
  };

  function messageLinks(entry: RegistryEntry, host?: string): MessageLinks | undefined {
    const seal = o.seal;
    if (!seal) return undefined;
    const origin = originOf(entry, host);
    return {
      url: (a) => {
        const payload: MessageLinkPayload = {
          a: a.action,
          en: a.entity,
          id: a.id,
          wf: a.workflow,
          st: a.step,
          exp: o.clock().getTime() + MESSAGE_LINK_TTL_MS,
        };
        const token = seal(payload, messageLinkAad(entry.systemId, entry.env));
        return `${origin}${MESSAGE_LINK_PATH}/${a.action}/${token}`;
      },
    };
  }

  function ctx(sys: ConnectorSystem, integ: Integration, host?: string): ConnectorCtx {
    const connector = getConnector(integ.connector);
    if (!connector) throw new ConnectorError("INVALID_REQUEST", `Неизвестный коннектор «${integ.connector}»`);
    const { entry, spec, data } = sys;
    const config = connector.configSchema.parse(integ.config ?? {});
    const secrets = secretsOf(entry.systemId, entry.env);
    const base = { system: entry.systemId, env: entry.env, integration: integ.name, connector: connector.id };
    const links = messageLinks(entry, host);
    return {
      system: {
        id: entry.systemId,
        env: entry.env,
        host: host ?? originOf(entry),
        spec,
        // Phone OTP is a Start/Business feature (F4): the only plan signal the registry carries in M1.
        plan: entry.features.phoneOtp ? "paid" : "free",
      },
      integration: { name: integ.name, config },
      secrets,
      mode: connector.testMode(entry.env, config, secrets),
      idempotencyKey: randomUUID(),
      users: contacts(data),
      db: systemDbOf(data),
      log: createConnectorLogger(base, (line) => o.log?.({ level: "info", msg: "connector", ...line })),
      fetch: fetchGuarded,
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
          await files?.write(m);
        },
      },
      now: o.clock,
      platform,
      telegramLinks: pgTelegramLinks(data),
      owners: () => ownersOf(entry.systemId),
      messages: pgMessageJournal(data),
      ...(links ? { messageLinks: links } : {}),
    };
  }

  const PLATFORM_MAIL: Integration = {
    name: "_platform",
    connector: "email",
    config: { provider: "platform" },
  };

  const integrations = (spec: AppSpec, connector: string) =>
    (spec.integrations ?? []).filter((i) => i.connector === connector);

  return {
    ctx,
    secrets: (entry) => secretsOf(entry.systemId, entry.env),
    platformMailCtx: (sys, host) => ctx(sys, PLATFORM_MAIL, host),
    platform,
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
