// API passports in the key window (V3-21 over V3-22): when an integration's contract comes from a passport, the window
// asks for the passport's own fields (Russian labels, hints, masked examples, shape checks) instead of one key, and the
// platform makes the stored key from them (passportKey: Basic for ЮKassa, the code of a Bitrix24 webhook, for СДЭК the
// Account and Secure password as one oauth2cc: value — the runtime egress client trades it for an access token of the
// contract's host at call time and keeps the token in memory; the platform stores no token). For per-account
// APIs (amoCRM, Bitrix24) the account comes from the fields: the window shows the owner the account's host as it is
// typed, and the contract is rebuilt for that account before the key check — the key goes only to that host.
import {
  type Passport,
  type PassportAccount,
  type PassportKeyCompose,
  passportContract,
  passportKey,
  passportStateOfContract,
} from "@wizard/agents/integrations";
import { getLatestBrief } from "../briefs/store.js";
import { invalid } from "../errors.js";
import { type IntegrationsDeps, saveContract } from "../integrations-v3/service.js";
import { type ContractRow, latestContract } from "../integrations-v3/store.js";

/** Fields that are not secret (shown in clear, never the source of the last 4 characters). */
const OPEN_FIELDS = new Set(["account", "shop_id", "client_id"]);

/** A field of the window as the page draws it (the pattern as source text). */
export interface WindowField {
  key: string;
  label_ru: string;
  hint_ru: string;
  example: string;
  pattern: string | null;
  flags: string;
  error_ru: string | null;
  /** Masked input (a key or a code) — false for an account address, a shop id, a client id. */
  secret: boolean;
}

/** The passport form of a window. */
export interface WindowForm {
  passport: string;
  name: string;
  where_ru: string;
  compose: PassportKeyCompose;
  fields: WindowField[];
  /** Per-account APIs: the account's host comes from the fields (the page shows it as typed). */
  account: {
    label_ru: string;
    example: string;
    suffixes: string[];
    customHost: boolean;
    reserved: string[];
    /** The field that carries the account address. */
    field: string;
  } | null;
}

export interface WindowPassport {
  passport: Passport;
  account: PassportAccount | null;
  sandbox: boolean;
  row: ContractRow;
}

/** The passport behind an integration's latest contract, or null. */
export async function windowPassport(
  pg: IntegrationsDeps["pg"],
  systemId: string,
  integrationId: string | null,
): Promise<WindowPassport | null> {
  if (!integrationId) return null;
  const row = await latestContract(pg, systemId, integrationId);
  const st = row ? passportStateOfContract(row.contract) : null;
  return row && st ? { ...st, row } : null;
}

export function windowForm(p: Passport): WindowForm {
  const accountField = p.key.fields.find((f) => f.key === "account" || f.key === "webhook_url")?.key ?? null;
  return {
    passport: p.id,
    name: p.name,
    where_ru: p.key.where_ru,
    compose: p.key.compose,
    fields: p.key.fields.map((f) => ({
      key: f.key,
      label_ru: f.label_ru,
      hint_ru: f.hint_ru,
      example: f.example,
      pattern: f.pattern ? f.pattern.source : null,
      flags: f.pattern ? f.pattern.flags.replace(/[gy]/g, "") : "",
      error_ru: f.error_ru ?? null,
      secret: !OPEN_FIELDS.has(f.key),
    })),
    account:
      p.account && accountField
        ? {
            label_ru: p.account.label_ru,
            example: p.account.example,
            suffixes: [...p.account.suffixes],
            customHost: p.account.customHost,
            reserved: [...p.account.reserved],
            field: accountField,
          }
        : null,
  };
}

/** The fields of a passport window from the opened plaintext ({"fields": {key: value}}). */
export function passportFields(plain: string, p: Passport): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(plain);
  } catch {
    raw = null;
  }
  const f = (raw as { fields?: unknown } | null)?.fields;
  if (!f || typeof f !== "object" || Array.isArray(f))
    throw invalid("Поля окна ключа не прочитались — откройте окно заново", { reason: "KEY_FORMAT" });
  const out: Record<string, string> = {};
  for (const field of p.key.fields) {
    const v = (f as Record<string, unknown>)[field.key];
    out[field.key] = typeof v === "string" ? v : "";
  }
  return out;
}

/** The last 4 characters of a passport key: of its secret field (not of the composed Basic or the token). */
export function passportSecretTail(p: Passport, fields: Readonly<Record<string, string>>): string {
  const f = p.key.fields.find((x) => !OPEN_FIELDS.has(x.key) && x.key !== "webhook_url");
  const v = (fields[f?.key ?? ""] ?? "").trim();
  if (p.key.compose === "webhook_url") {
    const code = /\/rest\/\d+\/([A-Za-z0-9]+)/.exec(fields.webhook_url ?? "")?.[1] ?? "";
    return code.length >= 12 ? code.slice(-4) : "";
  }
  return v.length >= 12 ? v.slice(-4) : "";
}

export interface PassportKeyOut {
  value: string;
  account: PassportAccount | null;
  last4: string;
}

/**
 * The stored key of a passport window: fields checked and composed by the passport (the test environment of the
 * contract for СДЭК: the oauth2cc value names its token endpoint).
 */
export function composePassportKey(wp: WindowPassport, plain: string): PassportKeyOut {
  const fields = passportFields(plain, wp.passport);
  const r = passportKey(wp.passport, fields, { sandbox: wp.sandbox });
  if (!r.ok) throw invalid(r.problems_ru.join(". "), { reason: "KEY_FORMAT", problems: r.problems_ru });
  return { value: r.value, account: r.account, last4: passportSecretTail(wp.passport, fields) };
}

const sameAccount = (a: PassportAccount | null, b: PassportAccount | null) =>
  (a?.host ?? null) === (b?.host ?? null) && (a?.user ?? null) === (b?.user ?? null);

/**
 * A per-account passport whose account the window changed: the contract is rebuilt for the account (same operations,
 * environment and key name) and saved without a key check — the caller checks the new key itself. Returns the hosts
 * of the integration after it.
 */
export async function adoptAccount(
  d: IntegrationsDeps,
  wp: WindowPassport,
  account: PassportAccount | null,
  o: { systemId: string; userId: string | null },
): Promise<string[]> {
  if (!wp.passport.account || !account || sameAccount(wp.account, account)) return [...wp.row.contract.hosts];
  const brief = await getLatestBrief(d.db, o.systemId);
  const c = wp.row.contract;
  const contract = passportContract(wp.passport, {
    id: c.id,
    name: c.name,
    ...(c.auth.secret ? { secret: c.auth.secret } : {}),
    account,
    sandbox: wp.sandbox,
    operations: c.operations.map((x) => x.id),
    data: (brief?.brief.data ?? []).map((x) => ({
      entity: x.entity,
      fields: x.fields.map((f) => ({ name: f.name })),
    })),
  });
  // No key is visible while saving: the old key is never sent to the new account's host.
  const blind: IntegrationsDeps = { ...d, secrets: { get: () => null } };
  const saved = await saveContract(blind, { systemId: o.systemId, contract, userId: o.userId });
  return [...saved.row.contract.hosts];
}
