// The passports and what the platform does with them without a model (V3-22): find a passport by the integration's name
// (Russian or English) or by a link to the provider, turn it into a validated contract for the brief's integration
// (the owner's account host, the test environment, the brief's data mapped by code), compose the key from what the
// owner pastes, request an OAuth token, and read a received webhook (trust check and the re-read operation).
import { createHash, timingSafeEqual } from "node:crypto";
import { EGRESS_HOST_RE } from "@wizard/appspec";
import type { IntegrationRequest } from "../client.js";
import {
  CONTRACT_FORMAT,
  CONTRACT_LIMITS,
  type ContractMapping,
  defaultSecretRef,
  type IntegrationContract,
  parseContract,
} from "../contract.js";
import { type MappingEntity, mapFields } from "../mapping.js";
import { amocrm } from "./amocrm.js";
import { bitrix24 } from "./bitrix24.js";
import { cdek } from "./cdek.js";
import { moysklad } from "./moysklad.js";
import { telegram } from "./telegram.js";
import type { Passport, PassportAccount, PassportId, PassportWebhookParse } from "./types.js";
import { yookassa } from "./yookassa.js";

/** Every passport (D77_v3 (15)). */
export const PASSPORTS: readonly Passport[] = [yookassa, cdek, telegram, amocrm, bitrix24, moysklad];

/** The passport by id; undefined for an unknown id. */
export const passportById = (id: string): Passport | undefined => PASSPORTS.find((p) => p.id === id);

/** Normalised word of a name: lowercase, ё → е (aliases are kept in this form). */
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Words of a text and every pair of neighbours glued («Мой склад» → «мойсклад», «amo CRM» → «amocrm»). */
function candidates(text: string): Set<string> {
  const words = norm(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const out = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]}${words[i + 1]}`);
  return out;
}

/**
 * The passport a name speaks of: one of its aliases is a word (or two neighbouring words) of the text. Two different
 * passports in one text — ambiguous, null.
 */
export function findPassport(text: string): Passport | null {
  const words = candidates(text);
  const hits = PASSPORTS.filter((p) => p.aliases.some((a) => words.has(a)));
  return hits.length === 1 ? (hits[0] as Passport) : null;
}

const hostOf = (raw: string): string | null => {
  const t = raw.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return null;
  }
};
const underDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const BITRIX_WEBHOOK_RE = /^\/rest\/(\d{1,10})\/([A-Za-z0-9]{6,64})\/?/;

/**
 * The owner's account in an address (a link into the account, a bare host or a subdomain): amoCRM
 * mycompany.amocrm.ru, Bitrix24 portal and the webhook's user (/rest/<user>/…). Null — not an account of this passport.
 */
export function passportAccountFromUrl(p: Passport, raw: string): PassportAccount | null {
  const spec = p.account;
  if (!spec) return null;
  const t = raw.trim().toLowerCase();
  const host = /^[a-z0-9][a-z0-9-]{0,62}$/.test(t) ? `${t}.${spec.suffixes[0]}` : hostOf(t);
  if (!host || !EGRESS_HOST_RE.test(host)) return null;
  const suffix = spec.suffixes.find((s) => host.endsWith(`.${s}`));
  if (suffix) {
    const sub = host.slice(0, -suffix.length - 1);
    if (sub.includes(".") || spec.reserved.includes(sub)) return null;
  } else if (!spec.customHost) return null;
  let user: string | undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${host}`);
    user = BITRIX_WEBHOOK_RE.exec(u.pathname)?.[1];
  } catch {
    user = undefined;
  }
  return { host, ...(user && p.baseUrl.includes("{user}") ? { user } : {}) };
}

/** The passport of a link: the provider's API or documentation domain, an account host, a Bitrix24 webhook. */
export function passportByUrl(raw: string): { passport: Passport; account: PassportAccount | null } | null {
  const host = hostOf(raw);
  if (!host) return null;
  for (const p of PASSPORTS)
    if (p.domains.some((d) => underDomain(host, d)))
      return { passport: p, account: passportAccountFromUrl(p, raw) };
  // A self-hosted Bitrix24: its incoming webhook address on the owner's own domain.
  try {
    if (BITRIX_WEBHOOK_RE.test(new URL(raw).pathname))
      return { passport: bitrix24, account: passportAccountFromUrl(bitrix24, raw) };
  } catch {
    return null;
  }
  return null;
}

/**
 * The brief → contract path without a model: a link decides when there is one (a provider's domain → its passport,
 * anything else → null, the documentation is read instead); without a link — the integration's name, then the need.
 */
export function passportForIntegration(o: {
  name: string;
  url?: string | null;
  need?: string | null;
}): { passport: Passport; account: PassportAccount | null } | null {
  if (o.url) return passportByUrl(o.url);
  const p = findPassport(o.name) ?? (o.need ? findPassport(o.need) : null);
  return p ? { passport: p, account: null } : null;
}

export interface PassportContractOptions {
  /** Integration id of the brief (default — the passport id). */
  id?: string;
  /** Integration name of the brief (default — the passport name). */
  name?: string;
  /** secret://name of the key (default secret://<id>_key). */
  secret?: string;
  /** The owner's account (amoCRM, Bitrix24); absent — the placeholder host until the key window gives it. */
  account?: PassportAccount | null;
  /** The provider's test environment (СДЭК api.edu.cdek.ru). */
  sandbox?: boolean;
  /** Only these operations (operationId or «METHOD /path»); the check operation always stays. */
  operations?: readonly string[];
  /** Data of the system mapped by code on top of the passport's hints. */
  data?: readonly MappingEntity[];
}

/** Base URL of a passport for an account (or its placeholder) and the environment. */
export function passportBaseUrl(
  p: Passport,
  o: { account?: PassportAccount | null; sandbox?: boolean } = {},
): string {
  if (o.sandbox && p.sandboxBaseUrl) return p.sandboxBaseUrl;
  const host = o.account?.host ?? p.account?.placeholder ?? "";
  return p.baseUrl.replace("{host}", host).replace("{user}", o.account?.user ?? "1");
}

function notesOf(p: Passport, o: PassportContractOptions): string[] {
  const out = [
    `Паспорт API «${p.name}» (сверен с документацией ${p.reviewed}): ${p.summary_ru}`,
    ...p.notes_ru,
    p.limits_ru,
    p.sandbox_ru,
  ];
  if (p.account && !o.account)
    out.push(
      `Адрес аккаунта ещё не указан — в контракте заглушка ${p.account.placeholder}; «${p.account.label_ru}» вводится в окне ключа.`,
    );
  if (o.sandbox && p.sandboxBaseUrl) out.push(`Контракт смотрит в тестовую среду: ${p.sandboxBaseUrl}.`);
  if (p.webhooks) out.push(`Вебхуки: ${p.webhooks.setup_ru}`, p.webhooks.verify_ru);
  for (const v of p.verify_ru) out.push(`Уточнить при проверке ключом: ${v}.`);
  return out.slice(0, 20);
}

/** A validated `wizard.integration/1` contract of a passport for a brief's integration (throws ContractInvalidError). */
export function passportContract(p: Passport, o: PassportContractOptions = {}): IntegrationContract {
  const id = o.id ?? p.id;
  const baseUrl = passportBaseUrl(p, o);
  const wanted = (o.operations ?? []).map((s) => s.trim()).filter(Boolean);
  const picked = p.operations.filter(
    (op) => op.id === p.check || wanted.includes(op.id) || wanted.includes(`${op.method} ${op.path}`),
  );
  const operations = wanted.length && picked.length > 1 ? picked : [...p.operations];
  const ids = new Set(operations.map((op) => op.id));
  const hints: ContractMapping[] = p.hints
    .filter((h) => ids.has(h.operation))
    .map((h) => ({ ...h, by: "name" as const }));
  const draft: IntegrationContract = {
    format: CONTRACT_FORMAT,
    id,
    name: (o.name ?? p.name).slice(0, 120),
    source: {
      kind: "passport",
      url: p.docsUrl,
      sha256: null,
      title: `Паспорт API «${p.name}»`,
      version: p.reviewed,
    },
    baseUrl,
    hosts: [new URL(baseUrl).hostname],
    auth: { kind: p.auth.kind, name: p.auth.name, secret: o.secret ?? defaultSecretRef(id) },
    operations: structuredClone(operations),
    check: { operation: p.check },
    mapping: hints,
    notes: notesOf(p, o),
  };
  const seen = new Set(hints.map((m) => `${m.entity}|${m.field}|${m.operation}|${m.pointer}`));
  const extra = o.data?.length
    ? mapFields(draft, o.data).filter((m) => !seen.has(`${m.entity}|${m.field}|${m.operation}|${m.pointer}`))
    : [];
  return parseContract({ ...draft, mapping: [...hints, ...extra].slice(0, CONTRACT_LIMITS.mapping) });
}

/** The passport a stored contract was made from (source passport + its documentation link). */
export const passportOfContract = (c: IntegrationContract): Passport | null =>
  c.source.kind === "passport" ? (PASSPORTS.find((p) => p.docsUrl === c.source.url) ?? null) : null;

/**
 * What a stored passport contract was made for — the account (not the placeholder) and the test environment — so a
 * rebuild of the same integration keeps them.
 */
export function passportStateOfContract(
  c: IntegrationContract,
): { passport: Passport; account: PassportAccount | null; sandbox: boolean } | null {
  const p = passportOfContract(c);
  if (!p) return null;
  const sandbox = p.sandboxBaseUrl !== null && c.baseUrl === p.sandboxBaseUrl;
  const u = new URL(c.baseUrl);
  if (!p.account || u.hostname === p.account.placeholder) return { passport: p, account: null, sandbox };
  const user = p.baseUrl.includes("{user}") ? u.pathname.split("/").filter(Boolean).at(-1) : undefined;
  return { passport: p, account: { host: u.hostname, ...(user ? { user } : {}) }, sandbox };
}

export type PassportKeyResult =
  | {
      ok: true;
      /**
       * The value of secret://<key>. OAuth client credentials (СДЭК) are one `oauth2cc:` value: the runtime egress
       * client trades it for an access token of the contract's host at call time and keeps the token in memory.
       */
      value: string;
      account: PassportAccount | null;
      /** A test key (ЮKassa test_…); null — the provider has no such mark. */
      test: boolean | null;
    }
  | { ok: false; problems_ru: string[] };

/**
 * The key of an integration from what the owner pasted into the key window: the shape of every field, the account of
 * per-account APIs, the composed value (Basic for ЮKassa, the code of a Bitrix24 webhook URL, OAuth client
 * credentials with the token endpoint of the environment for СДЭК). Never logs values.
 */
export function passportKey(
  p: Passport,
  fields: Readonly<Record<string, string>>,
  o: { sandbox?: boolean } = {},
): PassportKeyResult {
  const problems: string[] = [];
  const val: Record<string, string> = {};
  for (const f of p.key.fields) {
    const v = (fields[f.key] ?? "").trim();
    if (!v) problems.push(`Не заполнено поле «${f.label_ru}»`);
    else if (/\s/.test(v) || v.length > 4096)
      problems.push(`Поле «${f.label_ru}» — без пробелов и переносов`);
    else if (f.pattern && !f.pattern.test(v))
      problems.push(f.error_ru ?? `Поле «${f.label_ru}» заполнено неверно`);
    val[f.key] = v;
  }
  let account: PassportAccount | null = null;
  if (!problems.length && p.account) {
    account = passportAccountFromUrl(p, val.account ?? val.webhook_url ?? "");
    if (!account)
      problems.push(`Не получилось прочитать «${p.account.label_ru}»: пример — ${p.account.example}`);
  }
  if (problems.length) return { ok: false, problems_ru: problems };
  switch (p.key.compose) {
    case "basic":
      return {
        ok: true,
        value: `Basic ${Buffer.from(`${val.shop_id}:${val.secret_key}`).toString("base64")}`,
        account,
        test: (val.secret_key ?? "").startsWith("test_"),
      };
    case "oauth_client_credentials":
      return {
        ok: true,
        value: oauthClientValue({
          token_url: `${passportBaseUrl(p, o)}${p.key.token?.path ?? ""}`,
          client_id: val.client_id ?? "",
          client_secret: val.client_secret ?? "",
        }),
        account,
        test: o.sandbox === true && p.sandboxBaseUrl !== null,
      };
    case "webhook_url": {
      const code = BITRIX_WEBHOOK_RE.exec(safePath(val.webhook_url ?? ""))?.[2];
      if (!code || !account?.user)
        return {
          ok: false,
          problems_ru: ["Адрес вебхука должен выглядеть так: https://mycompany.bitrix24.ru/rest/1/<код>/"],
        };
      return { ok: true, value: code, account, test: null };
    }
    default:
      return {
        ok: true,
        value: val[p.key.fields.find((f) => f.key !== "account")?.key ?? ""] ?? "",
        account,
        test: null,
      };
  }
}

/**
 * OAuth client credentials as one secret value — the format the runtime egress client reads (@wizard/runtime
 * parseOAuthClientSecret): `oauth2cc:` + base64url of {token_url, client_id, client_secret}.
 */
const oauthClientValue = (c: { token_url: string; client_id: string; client_secret: string }) =>
  `oauth2cc:${Buffer.from(JSON.stringify(c), "utf8").toString("base64url")}`;

const safePath = (raw: string) => {
  try {
    return new URL(raw).pathname;
  } catch {
    return "";
  }
};

/**
 * OAuth client credentials (СДЭК): the token request the runtime egress client sends for an `oauth2cc:` key (the same
 * request, built here for the platform's own tools). The values travel in the form body only.
 */
export function passportTokenRequest(
  p: Passport,
  fields: Readonly<Record<string, string>>,
  o: { sandbox?: boolean } = {},
): IntegrationRequest | null {
  if (p.key.compose !== "oauth_client_credentials" || !p.key.token) return null;
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: (fields.client_id ?? "").trim(),
    client_secret: (fields.client_secret ?? "").trim(),
  });
  return {
    method: "POST",
    url: `${passportBaseUrl(p, o)}${p.key.token.path}`,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  };
}

/** The access token and its lifetime from the token answer; null — not a token answer. */
export function passportTokenValue(text: string): { value: string; expiresIn: number } | null {
  try {
    const j = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string" || !/^[A-Za-z0-9._~+/=-]{8,8192}$/.test(j.access_token))
      return null;
    const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
    return { value: j.access_token, expiresIn: ttl };
  } catch {
    return null;
  }
}

/** Constant-time comparison of two texts (by their sha256, so lengths do not leak). */
function sameToken(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b)) && a.length === b.length;
}

export interface PassportWebhookResult extends PassportWebhookParse {
  /** The payload may be acted on — after the re-read (`refetch`) where there is one. */
  ok: boolean;
  reason_ru: string | null;
}

/**
 * A received webhook of a passport's API: the payload (JSON or form, text or parsed), the shared token where the API
 * has one (Telegram header, Bitrix24 application_token), the event and the contract operation that re-reads the
 * object — the system decides only on that answer.
 */
export function passportWebhook(
  p: Passport,
  o: {
    headers?: Readonly<Record<string, string | undefined>>;
    body: string | Record<string, unknown>;
    token?: string | null;
  },
): PassportWebhookResult {
  const fail = (reason_ru: string): PassportWebhookResult => ({
    ok: false,
    reason_ru,
    event: null,
    refetch: null,
  });
  const w = p.webhooks;
  if (!w) return fail(`У «${p.name}» нет вебхуков`);
  let body: Record<string, unknown>;
  if (typeof o.body === "string") {
    try {
      body =
        w.contentType === "json"
          ? (JSON.parse(o.body) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(o.body));
    } catch {
      return fail("Тело уведомления не читается");
    }
  } else body = o.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Тело уведомления не читается");
  if (w.verify !== "refetch") {
    if (!o.token) return fail("Секрет вебхука не задан — уведомление не принято");
    const name = (w.tokenField ?? "").toLowerCase();
    const got =
      w.verify === "header_token"
        ? Object.entries(o.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1]
        : body[w.tokenField ?? ""];
    if (typeof got !== "string" || !sameToken(got, o.token))
      return fail("Секрет вебхука не совпал — уведомление не принято");
  }
  const parsed = w.parse(body);
  if (!parsed) return fail(`Это не уведомление «${p.name}»`);
  return { ok: true, reason_ru: null, ...parsed };
}

export type { PassportId };
