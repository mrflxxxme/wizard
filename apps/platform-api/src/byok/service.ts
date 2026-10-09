// BYOK store and router resolver (V3-33): consent, keys (sealed, last 4 visible), the check call, pause and revocation,
// and the ByokResolver the run engine hands to @wizard/llm. Every query runs in a transaction with
// pg_catalog.set_config('wizard.org_id', …, true) — the RLS of platform.byok_* (migration 0041). The plaintext key
// exists only inside addKey/check/apiKey() and is never logged, returned or put into an error.
import { randomUUID } from "node:crypto";
import {
  assertByokInput,
  BYOK_CALL_TYPES,
  BYOK_CATALOG,
  type ByokCatalog,
  type ByokCheckCode,
  type ByokOutcome,
  type ByokProviderDef,
  type ByokResolver,
  type ByokRoute,
  type ByokUrlViolation,
  byokBaseUrl,
  byokFetch,
  byokLast4,
  byokModelVerified,
  type CallType,
  checkByokKey,
  findByokProvider,
  LlmError,
} from "@wizard/llm";
import type postgres from "postgres";
import { ApiError, invalid, notFound } from "../errors.js";
import { type ByokConfig, byokOff } from "./config.js";
import { BYOK_CONSENT, type ByokConsentText, consentSha256 } from "./consent.js";
import { KmsError, keyAad, openKey, sealKey, type TransitKms } from "./kms.js";

/** Keys an org may hold at once (active or paused). */
export const BYOK_MAX_KEYS = 10;

export const BYOK_UNAVAILABLE_RU = "Свои ключи моделей пока недоступны для вашей организации";

/** Russian texts of the check verdicts (UI and API). */
export const CHECK_RU: Record<ByokCheckCode | "KMS_UNAVAILABLE", string> = {
  KEY_INVALID: "Провайдер не принял ключ: проверьте, что он скопирован целиком и не отозван",
  NO_BALANCE: "У провайдера закончились средства или квота на этом ключе",
  RATE_LIMITED: "Провайдер ограничил частоту запросов. Повторите проверку позже",
  REGION_BLOCKED: "Провайдер не принимает запросы из России. Укажите свой шлюз",
  MODEL_NOT_FOUND: "Провайдер не нашёл такую модель. Проверьте название",
  UNREACHABLE: "Не удалось связаться с провайдером или шлюзом",
  PROVIDER_ERROR: "Провайдер ответил ошибкой. Повторите проверку позже",
  KMS_UNAVAILABLE: "Хранилище ключей недоступно. Повторите позже",
};

/** Russian texts of the base URL violations (addKey 400). */
export const URL_RU: Record<ByokUrlViolation, string> = {
  gateway_required:
    "Этот провайдер не принимает запросы из России. Укажите адрес своего OpenAI-совместимого шлюза",
  gateway_not_allowed: "Этот провайдер подключается напрямую, адрес шлюза не нужен",
  bad_url: "Адрес шлюза указан с ошибкой: нужен адрес вида https://… без параметров",
  insecure_url: "Адрес шлюза должен начинаться с https://",
  credentials_in_url: "Уберите логин и пароль из адреса шлюза: ключ передаётся отдельно",
  official_host: "Это адрес самого провайдера, из России он недоступен. Укажите свой шлюз",
  private_host: "Адрес шлюза должен быть доступен из интернета",
};

/** Errors of real calls that disable the key until a new check (llm LiveErrorCode → check code). */
const DISABLING: Record<string, ByokCheckCode> = {
  HTTP_401: "KEY_INVALID",
  HTTP_403: "KEY_INVALID",
  PROVIDER_BALANCE_EXHAUSTED: "NO_BALANCE",
};

export interface ByokKeyView {
  id: string;
  provider: string;
  providerName: string;
  model: string;
  /** false → «не проверена нами». */
  verified: boolean;
  /** true → the provider is called directly; false → through the user's gateway. */
  direct: boolean;
  gatewayHost: string | null;
  last4: string;
  status: "active" | "paused" | "revoked";
  check: {
    status: "pending" | "ok" | "failed";
    code: string | null;
    message_ru: string | null;
    checkedAt: string | null;
  };
  lastUsedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

export interface ByokProviderView {
  id: string;
  name: string;
  direct: boolean;
  location: "ru" | "foreign";
  verifiedModels: string[];
  suggestedModels: string[];
}

export interface ByokState {
  available: boolean;
  consent?: { version: string; title: string; paragraphs: readonly string[]; acceptedAt: string | null };
  providers?: ByokProviderView[];
  keys?: ByokKeyView[];
  callTypes?: readonly CallType[];
}

interface KeyRow {
  id: string;
  org_id: string;
  provider: string;
  model: string;
  gateway_url: string | null;
  call_types: unknown;
  key_last4: string;
  ciphertext: string | null;
  wrapped_dek: string | null;
  status: "active" | "paused" | "revoked";
  check_status: "pending" | "ok" | "failed";
  check_code: string | null;
  checked_at: Date | null;
  last_used_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}

export interface ByokServiceOptions {
  pg: postgres.Sql;
  config: ByokConfig;
  kms: TransitKms | null;
  catalog?: ByokCatalog;
  /** HTTP of checks and calls; default byokFetch (guarded DNS, private hosts only with allowPrivateNetwork). */
  fetch?: typeof globalThis.fetch;
  consent?: ByokConsentText;
  now?: () => Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export class ByokService {
  readonly #o: ByokServiceOptions;
  readonly #catalog: ByokCatalog;
  readonly #consent: ByokConsentText;
  readonly #fetch: typeof globalThis.fetch;

  constructor(o: ByokServiceOptions) {
    this.#o = o;
    this.#catalog = o.catalog ?? BYOK_CATALOG;
    this.#consent = o.consent ?? BYOK_CONSENT;
    this.#fetch = o.fetch ?? byokFetch({ allowPrivateNetwork: o.config.allowPrivateNetwork });
  }

  /** Off for everyone (no public flag, no allowlisted org): the run engines get no router hook. */
  get off(): boolean {
    return byokOff(this.#o.config);
  }

  /** The flag (public or the org in WIZARD_BYOK_ORGS) and a configured KMS. */
  available(orgId: string): boolean {
    const c = this.#o.config;
    return !!this.#o.kms && (c.public || c.orgs.has(orgId.toLowerCase()));
  }

  #require(orgId: string): TransitKms {
    if (!this.available(orgId) || !this.#o.kms) throw new ApiError("FORBIDDEN", BYOK_UNAVAILABLE_RU);
    return this.#o.kms;
  }

  /** Runs fn in a transaction scoped to the org (RLS of platform.byok_*). */
  #tx<T>(orgId: string, fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return this.#o.pg.begin(async (sql) => {
      await sql`select pg_catalog.set_config('wizard.org_id', ${orgId}, true)`;
      return fn(sql);
    }) as Promise<T>;
  }

  #provider(id: string): ByokProviderDef | null {
    return findByokProvider(id, this.#catalog);
  }

  #view(r: KeyRow): ByokKeyView {
    const p = this.#provider(r.provider);
    let gatewayHost: string | null = null;
    try {
      gatewayHost = r.gateway_url ? new URL(r.gateway_url).host : null;
    } catch {
      gatewayHost = null;
    }
    const code = r.check_code as ByokCheckCode | "KMS_UNAVAILABLE" | null;
    return {
      id: r.id,
      provider: r.provider,
      providerName: p?.name ?? r.provider,
      model: r.model,
      verified: p ? byokModelVerified(p, r.model) : false,
      direct: p?.acceptsRu ?? false,
      gatewayHost,
      last4: r.key_last4,
      status: r.status,
      check: {
        status: r.check_status,
        code,
        message_ru: code ? (CHECK_RU[code] ?? CHECK_RU.PROVIDER_ERROR) : null,
        checkedAt: iso(r.checked_at),
      },
      lastUsedAt: iso(r.last_used_at),
      lastErrorCode: r.last_error_code,
      createdAt: r.created_at.toISOString(),
    };
  }

  async #consentRow(sql: postgres.TransactionSql, orgId: string) {
    const [row] = await sql<{ id: string; accepted_at: Date }[]>`
      select id, accepted_at from platform.byok_consents
      where org_id = ${orgId} and text_version = ${this.#consent.version}`;
    return row ?? null;
  }

  /** GET /orgs/:orgId/byok — the consent text, the provider list and the org's keys (never a key). */
  async state(orgId: string): Promise<ByokState> {
    if (!this.available(orgId)) return { available: false };
    return this.#tx(orgId, async (sql) => {
      const consent = await this.#consentRow(sql, orgId);
      const rows = await sql<KeyRow[]>`
        select * from platform.byok_keys
        where org_id = ${orgId} and status <> 'revoked' order by created_at desc`;
      return {
        available: true,
        consent: {
          version: this.#consent.version,
          title: this.#consent.title,
          paragraphs: this.#consent.paragraphs,
          acceptedAt: iso(consent?.accepted_at ?? null),
        },
        providers: this.#catalog.providers.map((p) => ({
          id: p.id,
          name: p.name,
          direct: p.acceptsRu,
          location: p.location,
          verifiedModels: [...p.verifiedModels],
          suggestedModels: [...p.suggestedModels],
        })),
        keys: rows.map((r) => this.#view(r)),
        callTypes: BYOK_CALL_TYPES,
      };
    });
  }

  /** The one-time consent of the current text version (idempotent). */
  async acceptConsent(orgId: string, userId: string, version: string): Promise<ByokState> {
    this.#require(orgId);
    if (version !== this.#consent.version)
      throw new ApiError("VERSION_CONFLICT", "Условия обновились. Прочитайте новую версию и подтвердите её");
    await this.#tx(orgId, async (sql) => {
      await sql`
        insert into platform.byok_consents (org_id, user_id, text_version, text_sha256)
        values (${orgId}, ${userId}, ${this.#consent.version}, ${consentSha256(this.#consent)})
        on conflict (org_id, text_version) do nothing`;
    });
    return this.state(orgId);
  }

  /** Seals and stores a key, then runs the check call with the plaintext still in hand. */
  async addKey(
    orgId: string,
    userId: string,
    input: { provider: string; model: string; key: string; gatewayUrl?: string | null; callTypes?: string[] },
  ): Promise<ByokKeyView> {
    const kms = this.#require(orgId);
    const provider = this.#provider(input.provider);
    if (!provider) throw invalid("Такого провайдера нет в списке", { field: "provider" });
    const model = input.model.trim();
    try {
      assertByokInput(input.key, model);
    } catch (e) {
      if (e instanceof LlmError)
        throw invalid(e.message, { field: /Ключ/.test(e.message) ? "key" : "model" });
      throw e;
    }
    const callTypes = input.callTypes ?? [];
    if (callTypes.some((ct) => !(BYOK_CALL_TYPES as readonly string[]).includes(ct)))
      throw invalid("Этот этап сборки не может идти на своём ключе", { field: "callTypes" });
    const base = byokBaseUrl(provider, input.gatewayUrl, {
      allowPrivateNetwork: this.#o.config.allowPrivateNetwork,
      catalog: this.#catalog,
    });
    if ("violation" in base)
      throw invalid(URL_RU[base.violation], { field: "gatewayUrl", reason: base.violation });
    const id = randomUUID();
    let sealed: { ciphertext: string; wrappedDek: string };
    try {
      sealed = await sealKey(kms, keyAad(orgId, id), input.key);
    } catch {
      throw new ApiError("LLM_UNAVAILABLE", CHECK_RU.KMS_UNAVAILABLE);
    }
    await this.#tx(orgId, async (sql) => {
      const consent = await this.#consentRow(sql, orgId);
      if (!consent)
        throw new ApiError(
          "CONSENT_REQUIRED",
          "Сначала прочитайте и примите условия подключения своих ключей",
        );
      const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
        select count(*)::int as n from platform.byok_keys where org_id = ${orgId} and status <> 'revoked'`;
      if (n >= BYOK_MAX_KEYS)
        throw new ApiError(
          "PLAN_LIMIT",
          `Можно подключить не больше ${BYOK_MAX_KEYS} ключей. Отзовите ненужный`,
        );
      await sql`
        insert into platform.byok_keys
          (id, org_id, provider, model, gateway_url, call_types, key_last4, ciphertext, wrapped_dek, kek_backend,
           kek_name, consent_id, created_by)
        values (${id}, ${orgId}, ${provider.id}, ${model}, ${provider.acceptsRu ? null : base.url},
          ${sql.json(callTypes)}, ${byokLast4(input.key)}, ${sealed.ciphertext}, ${sealed.wrappedDek},
          ${kms.backend}, ${kms.keyName}, ${consent.id}, ${userId})`;
    });
    return this.#runCheck(orgId, id, base.url, model, input.key);
  }

  async #row(sql: postgres.TransactionSql, orgId: string, keyId: string): Promise<KeyRow> {
    const [row] = await sql<KeyRow[]>`
      select * from platform.byok_keys where org_id = ${orgId} and id = ${keyId} and status <> 'revoked'`;
    if (!row) throw notFound("Ключ");
    return row;
  }

  #baseUrl(r: Pick<KeyRow, "provider" | "gateway_url">): string | null {
    const p = this.#provider(r.provider);
    if (!p) return null;
    const b = byokBaseUrl(p, r.gateway_url, {
      allowPrivateNetwork: this.#o.config.allowPrivateNetwork,
      catalog: this.#catalog,
    });
    return "url" in b ? b.url : null;
  }

  async #runCheck(
    orgId: string,
    keyId: string,
    baseUrl: string,
    model: string,
    key: string,
  ): Promise<ByokKeyView> {
    const verdict = await checkByokKey({ baseUrl, apiKey: key, model, fetch: this.#fetch });
    return this.#setCheck(orgId, keyId, verdict.ok ? null : verdict.code);
  }

  async #setCheck(orgId: string, keyId: string, code: string | null): Promise<ByokKeyView> {
    const now = this.#o.now?.() ?? new Date();
    return this.#tx(orgId, async (sql) => {
      const [row] = await sql<KeyRow[]>`
        update platform.byok_keys
        set check_status = ${code ? "failed" : "ok"}, check_code = ${code}, checked_at = ${now},
          last_error_code = case when ${code === null} then null else last_error_code end
        where org_id = ${orgId} and id = ${keyId} and status <> 'revoked'
        returning *`;
      if (!row) throw notFound("Ключ");
      return this.#view(row);
    });
  }

  /** POST …/keys/:keyId/check — decrypts the key for one check call. */
  async check(orgId: string, keyId: string): Promise<ByokKeyView> {
    const kms = this.#require(orgId);
    const row = await this.#tx(orgId, (sql) => this.#row(sql, orgId, keyId));
    const baseUrl = this.#baseUrl(row);
    if (!baseUrl || !row.ciphertext || !row.wrapped_dek)
      return this.#setCheck(orgId, keyId, "PROVIDER_ERROR");
    let key: string;
    try {
      key = await openKey(kms, keyAad(orgId, keyId), {
        ciphertext: row.ciphertext,
        wrappedDek: row.wrapped_dek,
      });
    } catch {
      return this.#setCheck(orgId, keyId, "KMS_UNAVAILABLE");
    }
    return this.#runCheck(orgId, keyId, baseUrl, row.model, key);
  }

  /** PATCH …/keys/:keyId — «use in builds» on or off. */
  async setStatus(orgId: string, keyId: string, status: "active" | "paused"): Promise<ByokKeyView> {
    this.#require(orgId);
    return this.#tx(orgId, async (sql) => {
      await this.#row(sql, orgId, keyId);
      const [row] = await sql<KeyRow[]>`
        update platform.byok_keys set status = ${status}
        where org_id = ${orgId} and id = ${keyId} returning *`;
      return this.#view(row as KeyRow);
    });
  }

  /** DELETE …/keys/:keyId — revocation destroys the ciphertext and the wrapped data key (crypto-shredding). */
  async revoke(orgId: string, keyId: string, userId: string): Promise<ByokKeyView> {
    // Revocation stays possible when the flag was switched off after the key was added.
    const now = this.#o.now?.() ?? new Date();
    return this.#tx(orgId, async (sql) => {
      await this.#row(sql, orgId, keyId);
      const [row] = await sql<KeyRow[]>`
        update platform.byok_keys
        set status = 'revoked', ciphertext = null, wrapped_dek = null, revoked_at = ${now}, revoked_by = ${userId}
        where org_id = ${orgId} and id = ${keyId} returning *`;
      return this.#view(row as KeyRow);
    });
  }

  /**
   * The ByokResolver of the run engine: the org's most recently checked active key whose call types include the call
   * (an empty list — every BYOK call type), only with the consent of the current text version.
   */
  resolver(): ByokResolver {
    const orgOf = new Map<string, string>();
    const kms = this.#o.kms;
    return {
      fetch: this.#fetch,
      allowPrivateNetwork: this.#o.config.allowPrivateNetwork,
      resolve: async (orgId: string, callType: CallType): Promise<ByokRoute | null> => {
        if (!kms || !this.available(orgId)) return null;
        const row = await this.#tx(orgId, async (sql) => {
          if (!(await this.#consentRow(sql, orgId))) return null;
          const rows = await sql<KeyRow[]>`
            select * from platform.byok_keys
            where org_id = ${orgId} and status = 'active' and check_status = 'ok'
            order by checked_at desc nulls last, created_at desc`;
          return (
            rows.find((r) => {
              const cts = Array.isArray(r.call_types) ? (r.call_types as string[]) : [];
              return cts.length === 0 || cts.includes(callType);
            }) ?? null
          );
        });
        if (!row?.ciphertext || !row.wrapped_dek) return null;
        const provider = this.#provider(row.provider);
        const baseUrl = this.#baseUrl(row);
        if (!provider || !baseUrl) return null;
        orgOf.set(row.id, orgId);
        const sealed = { ciphertext: row.ciphertext, wrappedDek: row.wrapped_dek };
        return {
          keyId: row.id,
          providerId: provider.id,
          model: row.model,
          baseUrl,
          body: provider.body,
          verified: byokModelVerified(provider, row.model),
          apiKey: () => openKey(kms, keyAad(orgId, row.id), sealed),
        };
      },
      report: async (keyId: string, outcome: ByokOutcome) => {
        const orgId = orgOf.get(keyId);
        if (!orgId) return;
        const now = this.#o.now?.() ?? new Date();
        const disabling = outcome.errorCode ? DISABLING[outcome.errorCode] : undefined;
        await this.#tx(orgId, async (sql) => {
          if (outcome.ok)
            await sql`update platform.byok_keys set last_used_at = ${now}, last_error_code = null
              where org_id = ${orgId} and id = ${keyId}`;
          else if (disabling)
            await sql`update platform.byok_keys
              set last_error_code = ${outcome.errorCode}, check_status = 'failed', check_code = ${disabling},
                checked_at = ${now}
              where org_id = ${orgId} and id = ${keyId}`;
          else
            await sql`update platform.byok_keys set last_error_code = ${outcome.errorCode}
              where org_id = ${orgId} and id = ${keyId}`;
        }).catch(() => undefined);
      },
    };
  }
}

export { KmsError };
