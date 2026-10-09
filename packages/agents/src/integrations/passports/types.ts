// Passport of a popular Russian API (V3-22; D77_v3 (15)): a reviewed `wizard.integration/1` contract template with what
// the build would otherwise read in the documentation — hosts, the key and what the owner pastes, operations with
// schemas and answers from the docs, the safe check, limits, webhooks, test modes, mapping hints onto module entities.
// Facts come from the official public documentation (no live calls); what is not certain is listed in `verify_ru`
// («уточнить при проверке ключом») instead of being invented.

import type { OperationInput } from "../client.js";
import type { ContractMapping, ContractOperation } from "../contract.js";

export const PASSPORT_IDS = ["yookassa", "cdek", "telegram", "amocrm", "bitrix24", "moysklad"] as const;
export type PassportId = (typeof PASSPORT_IDS)[number];

/** A field the owner pastes into the key window (Russian label and where to find it). */
export interface PassportKeyField {
  key: string;
  label_ru: string;
  hint_ru: string;
  /** Masked shape of the value (never a real key). */
  example: string;
  /** Shape check of the pasted value (trimmed) and its Russian error. */
  pattern?: RegExp;
  error_ru?: string;
}

/**
 * How the stored key (one secret://name) is made from the fields: plain — the field as is; basic — `Basic
 * base64(a:b)`; oauth_client_credentials — an access token the platform requests and refreshes; webhook_url — the code
 * of an incoming webhook URL (its host and user become the account).
 */
export type PassportKeyCompose = "plain" | "basic" | "oauth_client_credentials" | "webhook_url";

export interface PassportKey {
  fields: readonly PassportKeyField[];
  compose: PassportKeyCompose;
  /** Where the owner gets the key, Russian. */
  where_ru: string;
  /** OAuth client credentials (compose oauth_client_credentials): token endpoint path and token lifetime. */
  token?: { path: string; ttlSeconds: number };
}

/** The owner's account of an API served on per-account hosts (amoCRM subdomain, Bitrix24 portal). */
export interface PassportAccountSpec {
  label_ru: string;
  /** Example address (fictional). */
  example: string;
  /** Hosts of accounts end with one of these. */
  suffixes: readonly string[];
  /** Any public host is an account too (self-hosted Bitrix24). */
  customHost: boolean;
  /** Subdomains of the suffixes that are not accounts (documentation, marketing). */
  reserved: readonly string[];
  /** Host of the contract until the owner gives the account (the key check fails on it, nothing leaks). */
  placeholder: string;
}

/** An account: its host and, for Bitrix24, the user of the incoming webhook. */
export interface PassportAccount {
  host: string;
  user?: string;
}

/** Mapping hint: a field of a module entity (lead, deal, booking, order, product, client) ↔ a request or answer field. */
export type PassportHint = Omit<ContractMapping, "by">;

/** What a received webhook means and how to trust it. */
export interface PassportWebhookParse {
  event: string | null;
  /** The contract operation that re-reads the object (the decision is taken only on its answer). */
  refetch: { operation: string; input: OperationInput } | null;
}

export interface PassportWebhooks {
  /** Event names as the provider sends them. */
  events: readonly string[];
  /** How to switch them on, Russian. */
  setup_ru: string;
  /**
   * refetch — no signature: re-read the object by id with the key; header_token — a shared token in a header;
   * body_token — a shared token in the payload; the last two are re-read too where possible.
   */
  verify: "refetch" | "header_token" | "body_token";
  /** Header (header_token) or form field (body_token) of the shared token. */
  tokenField?: string;
  /** Payload content type. */
  contentType: "json" | "form";
  verify_ru: string;
  /** Event and the re-read of a payload (JSON object or form fields); null — not an event of this API. */
  parse(body: Record<string, unknown>): PassportWebhookParse | null;
}

export interface Passport {
  id: PassportId;
  name: string;
  /** Names in Russian and English, normalised (lowercase, ё → е, no spaces or punctuation). */
  aliases: readonly string[];
  /** Registrable domains of the API and its documentation: a link to them picks the passport. */
  domains: readonly string[];
  summary_ru: string;
  docsUrl: string;
  /** Date the passport was checked against the documentation. */
  reviewed: string;
  /** Base URL; `{host}` (and `{user}`) are the account's for per-account APIs. */
  baseUrl: string;
  /** Test environment with its own base URL (СДЭК); null — test mode by the key or none. */
  sandboxBaseUrl: string | null;
  auth: { kind: "bearer" | "header" | "path"; name: string | null };
  account: PassportAccountSpec | null;
  key: PassportKey;
  operations: readonly ContractOperation[];
  /** The safe GET of the key check. */
  check: string;
  /** Documentation link of every operation. */
  docs: Readonly<Record<string, string>>;
  hints: readonly PassportHint[];
  limits_ru: string;
  sandbox_ru: string;
  webhooks: PassportWebhooks | null;
  /** Notes for the builder and the owner (contract notes). */
  notes_ru: readonly string[];
  /** Fields and behaviour not certain from the documentation — «уточнить при проверке ключом». */
  verify_ru: readonly string[];
}
