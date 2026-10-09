// API passports (V3-22; D77_v3 (15)): reviewed contracts of ЮKassa, СДЭК, Telegram, amoCRM, Битрикс24, МойСклад.
/** The six passports, one by id. */
export { amocrm } from "./amocrm.js";
export { bitrix24 } from "./bitrix24.js";
export { cdek } from "./cdek.js";
export { moysklad } from "./moysklad.js";
/** Registry: find by name or link, contract for a brief's integration, key from the owner's fields, OAuth token, webhooks. */
export {
  findPassport,
  PASSPORTS,
  type PassportContractOptions,
  type PassportKeyResult,
  type PassportWebhookResult,
  passportAccountFromUrl,
  passportBaseUrl,
  passportById,
  passportByUrl,
  passportContract,
  passportForIntegration,
  passportKey,
  passportOfContract,
  passportStateOfContract,
  passportTokenRequest,
  passportTokenValue,
  passportWebhook,
} from "./registry.js";
export { telegram } from "./telegram.js";
/** Passport shape: account of per-account APIs, key fields and composition, webhooks, mapping hints. */
export {
  PASSPORT_IDS,
  type Passport,
  type PassportAccount,
  type PassportAccountSpec,
  type PassportHint,
  type PassportId,
  type PassportKey,
  type PassportKeyCompose,
  type PassportKeyField,
  type PassportWebhookParse,
  type PassportWebhooks,
} from "./types.js";
export { yookassa } from "./yookassa.js";
