// The only place where a key from the window exists in clear (V3-21; security/data-boundary.yaml#secret_window): the KMS
// unwraps the window's private key for one opening, the key is decrypted, checked through the egress client of V3-20
// (onIntegrationKey — only the contract's hosts, which are within the hosts the owner saw in the window) and written to
// the secret store (SecretStore → secrets_refs). Rotation: the new key replaces the old one only when its check passes
// (or the old one was not working); otherwise the old key stays and the integrations are re-checked with it. Nothing
// here logs, returns or stores the value elsewhere — callers get the last 4 characters and the check results.
import type { PassportAccount } from "@wizard/agents/integrations";
import { KmsError, openKey, type TransitKms } from "../byok/kms.js";
import { ApiError, invalid } from "../errors.js";
import { type IntegrationsDeps, onIntegrationKey, saveContract } from "../integrations-v3/service.js";
import { type ContractRow, latestContracts } from "../integrations-v3/store.js";
import type { SecretStore } from "../secrets/store.js";
import { openSealedSecret, SealError, type SealedSecret, windowContext } from "./crypto.js";
import { adoptAccount, composePassportKey, type WindowPassport } from "./passport.js";
import {
  type BindingRow,
  type BindingStatus,
  closeWindow,
  getBinding,
  upsertBinding,
  type WindowRow,
  withOrg,
} from "./store.js";

/** AAD of a window's sealed private key: binds it to the org and the window (a copied row does not open elsewhere). */
export const windowKeyAad = (orgId: string, windowId: string): string => `secret-window:${orgId}:${windowId}`;

/** Key text limits (one line of printable ASCII). */
export const KEY_MIN = 8;
export const KEY_MAX = 4096;

/** Why a decrypted key cannot be stored (Russian), or null. Leading and trailing whitespace is ignored. */
export function keyProblem(value: string): string | null {
  if (value.startsWith("secret://"))
    return "Это ссылка на ключ, а не сам ключ — вставьте значение из кабинета сервиса";
  if (value.length < KEY_MIN) return `Ключ слишком короткий — нужно не меньше ${KEY_MIN} символов`;
  if (value.length > KEY_MAX) return `Ключ слишком длинный — не больше ${KEY_MAX} символов`;
  if (!/^[\x21-\x7e]+$/.test(value))
    return "Ключ — одна строка из латинских букв, цифр и знаков, без пробелов и переносов";
  return null;
}

/** The last 4 characters shown after saving (none for keys shorter than 12 — they would give away too much). */
export const lastFour = (value: string): string => (value.length >= 12 ? value.slice(-4) : "");

export interface VaultDeps {
  pg: IntegrationsDeps["pg"];
  db: IntegrationsDeps["db"];
  config: IntegrationsDeps["config"];
  secrets: SecretStore;
  kms: TransitKms | null;
  research?: IntegrationsDeps["research"];
  keyCheck?: IntegrationsDeps["keyCheck"];
}

export interface KeyCheckLine {
  integrationId: string;
  ok: boolean;
  status: ContractRow["status"];
  message_ru: string;
  /** The KeyCheckResult code V3-20 stored on the contract (OK, AUTH_FAILED, …). */
  code?: string;
}

export interface AcceptedKey {
  /** The new key is stored (false — a rotation whose check failed: the old key stays). */
  saved: boolean;
  binding: BindingRow | null;
  checks: KeyCheckLine[];
}

const integrationsDeps = (d: VaultDeps, secrets: IntegrationsDeps["secrets"]): IntegrationsDeps => ({
  db: d.db,
  pg: d.pg,
  config: d.config,
  secrets,
  ...(d.research ? { research: d.research } : {}),
  ...(d.keyCheck ? { keyCheck: d.keyCheck } : {}),
});

/** Status and the first problem of check lines (no lines — nothing to check yet). */
export function bindingCheck(checks: readonly KeyCheckLine[]): {
  status: BindingStatus;
  code: string | null;
  message: string | null;
} {
  if (checks.length === 0) return { status: "unchecked", code: null, message: null };
  const bad = checks.find((c) => !c.ok);
  return bad
    ? { status: "failed", code: bad.code ?? "CHECK_FAILED", message: bad.message_ru.slice(0, 500) }
    : { status: "ok", code: "OK", message: checks[0]?.message_ru.slice(0, 500) ?? null };
}

/** The integrations of V3-20 re-checked with what the secret store has now (after a failed rotation or a re-check). */
export async function recheckStored(
  d: VaultDeps,
  p: { systemId: string; env: "draft" | "prod"; name: string },
): Promise<KeyCheckLine[]> {
  return withCodes(
    d,
    p.systemId,
    await onIntegrationKey(integrationsDeps(d, d.secrets), {
      systemId: p.systemId,
      secretName: p.name,
      env: p.env,
    }),
  );
}

/** onIntegrationKey lines with the stored check code of each contract (V3-20 keeps the KeyCheckResult). */
async function withCodes(d: VaultDeps, systemId: string, lines: KeyCheckLine[]): Promise<KeyCheckLine[]> {
  if (lines.length === 0) return lines;
  const rows = await d.pg`
    select distinct on (c.integration_id) c.integration_id, c.key_check
      from platform.system_integration_contracts c
     where c.system_id = ${systemId} order by c.integration_id, c.version desc`;
  const codes = new Map(
    rows.map((r) => {
      const kc = typeof r.key_check === "string" ? JSON.parse(r.key_check) : r.key_check;
      return [r.integration_id as string, typeof kc?.code === "string" ? (kc.code as string) : undefined];
    }),
  );
  return lines.map((l) => {
    const code = codes.get(l.integrationId);
    return code ? { ...l, code } : l;
  });
}

/**
 * Opens a sealed key of an open window, checks it and stores it (see the header). The window is closed («filled») right
 * after a successful opening — before the check — so it is used once; a sealed key that does not open or a key of a
 * wrong format leaves the window open.
 */
export async function acceptKey(
  d: VaultDeps,
  p: {
    window: WindowRow;
    sealed: SealedSecret;
    userId: string | null;
    contracts: readonly ContractRow[];
    /** The passport of the integration (its fields instead of one key), or null. */
    passport: WindowPassport | null;
  },
): Promise<AcceptedKey> {
  const w = p.window;
  if (!d.kms) throw new ApiError("INTERNAL", "Хранилище ключей платформы недоступно — попробуйте позже");
  if (!w.sealedPrivate || !w.wrappedDek)
    throw invalid("Окно ключа ещё не готово — обновите страницу", { reason: "WINDOW_NOT_READY" });
  let plain: string;
  let pkcs8: Buffer | null = null;
  try {
    pkcs8 = Buffer.from(
      await openKey(d.kms, windowKeyAad(w.orgId, w.id), {
        ciphertext: w.sealedPrivate,
        wrappedDek: w.wrappedDek,
      }),
      "base64",
    );
    plain = (await openSealedSecret(pkcs8, p.sealed, w.id, windowContext(w))).trim();
  } catch (e) {
    if (e instanceof KmsError)
      throw new ApiError("INTERNAL", "Хранилище ключей платформы недоступно — попробуйте позже");
    if (e instanceof SealError)
      throw invalid("Ключ не расшифровался — закройте окно и откройте его снова", { reason: "SEAL_INVALID" });
    throw e;
  } finally {
    pkcs8?.fill(0);
  }
  let value: string;
  let last4: string;
  let account: PassportAccount | null = null;
  if (p.passport) {
    // A passport's fields (V3-22): checked and composed here (СДЭК: one oauth2cc value, the runtime gets the token).
    ({ value, last4, account } = composePassportKey(p.passport, plain));
  } else {
    value = plain;
    const problem = keyProblem(value);
    if (problem) throw invalid(problem, { reason: "KEY_FORMAT" });
    last4 = lastFour(value);
  }
  const claimed = await withOrg(d.pg, w.orgId, (tx) => closeWindow(tx, w.id, "filled"));
  if (!claimed) throw invalid("Это окно ключа уже использовано", { reason: "WINDOW_CLOSED" });

  // A per-account API: the contract follows the account the owner typed (and saw) in the window.
  let hosts = w.hosts;
  let contracts = p.contracts;
  let rebuilt = false;
  if (p.passport?.passport.account) {
    hosts = await adoptAccount(integrationsDeps(d, d.secrets), p.passport, account, {
      systemId: w.systemId,
      userId: p.userId,
    });
    rebuilt = hosts.join(",") !== p.passport.row.contract.hosts.join(",");
    contracts = (await latestContracts(d.pg, w.systemId)).filter(
      (c) => c.contract.auth.secret === `secret://${w.name}`,
    );
  }

  const prev = await withOrg(d.pg, w.orgId, (tx) => getBinding(tx, w.systemId, w.env, w.name));
  const stored = d.secrets;
  const candidate: IntegrationsDeps["secrets"] = {
    get: (systemId, env, name) =>
      systemId === w.systemId && env === w.env && name === w.name ? value : stored.get(systemId, env, name),
  };
  const checks = contracts.length
    ? await withCodes(
        d,
        w.systemId,
        await onIntegrationKey(integrationsDeps(d, candidate), {
          systemId: w.systemId,
          secretName: w.name,
          env: w.env,
        }),
      )
    : [];
  const verdict = bindingCheck(checks);
  const oldWorks = prev?.status === "ok" && stored.get(w.systemId, w.env, w.name) !== null;
  if (verdict.status === "failed" && oldWorks) {
    // Rotation refused: the old key stays; the contract goes back to the old account (the old key never reaches the
    // new host) and the contracts get their state back with the old key.
    if (rebuilt && p.passport)
      await saveContract(
        { ...integrationsDeps(d, d.secrets), secrets: { get: () => null } },
        { systemId: w.systemId, contract: p.passport.row.contract, userId: p.userId },
      );
    await recheckStored(d, { systemId: w.systemId, env: w.env, name: w.name });
    return { saved: false, binding: prev, checks };
  }
  await d.db.transaction().execute((trx) =>
    stored.put(trx, {
      orgId: w.orgId,
      systemId: w.systemId,
      env: w.env,
      name: w.name,
      value,
      createdBy: p.userId,
    }),
  );
  const binding = await withOrg(d.pg, w.orgId, (tx) =>
    upsertBinding(tx, {
      orgId: w.orgId,
      systemId: w.systemId,
      env: w.env,
      name: w.name,
      integrationId: w.integrationId,
      hosts,
      last4,
      status: verdict.status,
      checkCode: verdict.code,
      checkMessage: verdict.message,
      windowId: w.id,
      createdBy: p.userId,
    }),
  );
  return { saved: true, binding, checks };
}
