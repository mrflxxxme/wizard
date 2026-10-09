// The key window of a system (V3-21; D77_v3 (15), D37; security/data-boundary.yaml#secret_window): the build agent
// (request_secret) or the owner opens a window for secret://<name> with the recipient hosts and the purpose; the page
// gets the window's public key, encrypts the key in the browser and submits the ciphertext; vault.ts opens it inside the
// secret store, checks it by the contract (V3-20 onIntegrationKey) and stores it. Rotation is a new window for the same
// name; removal deletes the value and switches the integrations back to the mock. The model only ever sees
// secret://<name>; the owner sees the hosts, the last 4 characters and the check — never the value again.
import { passportAccountFromUrl, passportStateOfContract } from "@wizard/agents/integrations";
import { egressHostProblem, platformDomains } from "@wizard/connectors";
import { hasSecret } from "@wizard/pii";
import { getLatestBrief } from "../briefs/store.js";
import { sealKey } from "../byok/kms.js";
import { ApiError, invalid, notFound } from "../errors.js";
import {
  type ContractRow,
  latestContract,
  latestContracts,
  setContractCheck,
} from "../integrations-v3/store.js";
import {
  isSealedSecret,
  newWindowKeyPair,
  WINDOW_ALG,
  type WindowPublicKey,
  windowContext,
} from "./crypto.js";
import { type WindowForm, windowForm, windowPassport } from "./passport.js";
import {
  type BindingRow,
  closeWindow,
  deleteBinding,
  type Env,
  expireWindows,
  getBinding,
  getWindow,
  insertWindow,
  listBindings,
  listOpenWindows,
  openWindowFor,
  secretRefExists,
  setBindingCheck,
  setWindowKey,
  systemOrg,
  type WindowRow,
  withOrg,
} from "./store.js";
import {
  acceptKey,
  bindingCheck,
  type KeyCheckLine,
  recheckStored,
  type VaultDeps,
  windowKeyAad,
} from "./vault.js";

export type SecretWindowDeps = VaultDeps & {
  /** Domains of the platform a key never goes to (default: connectors platformDomains of the env). */
  platformDomains?: readonly string[];
};

/** secret://<name>: a letter, then letters, digits and «_», up to 64 (db.yaml#secret_windows.name). */
export const SECRET_WINDOW_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const INTEGRATION_ID = /^[a-z][a-z0-9_]{0,39}$/;

/** A window as the owner sees it (no key material except the public key of an open window). */
export interface WindowView {
  id: string;
  env: Env;
  name: string;
  secretRef: string;
  integrationId: string | null;
  integrationName: string | null;
  hosts: string[];
  purpose: string;
  requestedBy: "agent" | "user";
  status: WindowRow["status"];
  expiresAt: string;
  createdAt: string;
}

/** An open window with what the browser needs to encrypt the key. */
export interface WindowKeyView extends WindowView {
  alg: typeof WINDOW_ALG;
  publicKey: WindowPublicKey;
  /** Additional data and HKDF info of the encryption (crypto.ts windowContext). */
  context: string;
  /**
   * The passport's fields (V3-22) — the page encrypts {"fields": {…}} instead of one key; for per-account APIs the
   * key goes to the account typed into `form.account.field`. null — one key.
   */
  form: WindowForm | null;
}

/** A stored key: where it may go, its last 4 characters, version and check — never the value. */
export interface SecretView {
  name: string;
  secretRef: string;
  env: Env;
  integrationId: string | null;
  integrationName: string | null;
  hosts: string[];
  last4: string;
  version: number;
  status: BindingRow["status"];
  check: { code: string | null; message_ru: string | null; checkedAt: string | null };
  rotatedAt: string | null;
  createdAt: string;
}

/** An outgoing integration of the brief and its key. */
export interface NeededKey {
  integrationId: string;
  integrationName: string;
  name: string;
  secretRef: string;
  /** The contract's hosts; null — no contract yet (no window: the recipient is unknown). */
  hosts: string[] | null;
  /** A value is set (draft or prod). */
  present: boolean;
  /** The contract says the API needs no key. */
  keyless: boolean;
  /**
   * A per-account passport API (amoCRM, Bitrix24) whose account is not set yet: the key goes to the account the owner
   * types into the window (hosts holds the placeholder until then).
   */
  account: { label_ru: string; suffixes: string[] } | null;
}

const ref = (name: string) => `secret://${name}`;
const hostsOf = (deps: Pick<SecretWindowDeps, "platformDomains">) =>
  deps.platformDomains ?? platformDomains(process.env);

async function names(deps: SecretWindowDeps, systemId: string): Promise<Map<string, string>> {
  const brief = await getLatestBrief(deps.db, systemId);
  return new Map((brief?.brief.integrations ?? []).map((i) => [i.id, i.name]));
}

function windowView(w: WindowRow, integrationName: string | null): WindowView {
  return {
    id: w.id,
    env: w.env,
    name: w.name,
    secretRef: ref(w.name),
    integrationId: w.integrationId,
    integrationName,
    hosts: w.hosts,
    purpose: w.purpose,
    requestedBy: w.requestedBy,
    status: w.status,
    expiresAt: w.expiresAt,
    createdAt: w.createdAt,
  };
}

export function secretView(b: BindingRow, integrationName: string | null): SecretView {
  return {
    name: b.name,
    secretRef: ref(b.name),
    env: b.env,
    integrationId: b.integrationId,
    integrationName,
    hosts: b.hosts,
    last4: b.last4,
    version: b.version,
    status: b.status,
    check: { code: b.checkCode, message_ru: b.checkMessage, checkedAt: b.checkedAt },
    rotatedAt: b.rotatedAt,
    createdAt: b.createdAt,
  };
}

async function orgOf(deps: Pick<SecretWindowDeps, "pg">, systemId: string): Promise<string> {
  const s = await systemOrg(deps.pg, systemId);
  if (!s) throw notFound("Система");
  return s.orgId;
}

/** Contracts (latest versions) whose key is secret://<name>. */
async function contractsUsing(deps: Pick<SecretWindowDeps, "pg">, systemId: string, name: string) {
  return (await latestContracts(deps.pg, systemId)).filter((c) => c.contract.auth.secret === ref(name));
}

/** Hosts of the contracts that the window or the binding does not cover (D37: the key goes only where the owner saw). */
export function uncoveredHosts(contracts: readonly ContractRow[], hosts: readonly string[]): string[] {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  return [
    ...new Set(contracts.flatMap((c) => c.contract.hosts.filter((h) => !allowed.has(h.toLowerCase())))),
  ];
}

export interface SecretRequest {
  systemId: string;
  name: string;
  /** The recipient domain the agent names; with a contract it must be one of the contract's hosts. */
  domain?: string;
  purpose: string;
  integrationId?: string | null;
  env?: Env;
  runId?: string | null;
  requestedBy: "agent" | "user";
  userId?: string | null;
}

/**
 * request_secret: a window for secret://<name> with its hosts (the contract's hosts when the integration has one, else
 * the agent's domain) and its purpose. An open window of the same name with the same hosts is returned as it is.
 */
export async function requestSecret(
  deps: Pick<SecretWindowDeps, "pg" | "platformDomains">,
  p: SecretRequest,
): Promise<{ window: WindowRow; created: boolean }> {
  if (!SECRET_WINDOW_NAME.test(p.name))
    throw invalid("Имя ключа — латинские буквы, цифры и «_», с буквы, до 64 символов", { reason: "NAME" });
  const purpose = p.purpose.trim().replace(/\s+/g, " ");
  if (purpose.length < 1 || purpose.length > 300)
    throw invalid("Назначение ключа — от 1 до 300 символов", { reason: "PURPOSE" });
  if (hasSecret(purpose))
    throw invalid("В назначении не должно быть самого ключа", { reason: "SECRET_IN_TEXT" });
  if (p.integrationId != null && !INTEGRATION_ID.test(p.integrationId)) throw notFound("Интеграция");
  const env = p.env ?? "draft";
  const orgId = await orgOf(deps, p.systemId);
  let hosts: string[];
  const contract = p.integrationId ? await latestContract(deps.pg, p.systemId, p.integrationId) : null;
  const domain = p.domain?.trim().toLowerCase().replace(/\.$/, "");
  if (contract) {
    const c = contract.contract;
    if (c.auth.secret === null) throw invalid(`API «${c.name}» работает без ключа`, { reason: "KEYLESS" });
    if (c.auth.secret !== ref(p.name))
      throw invalid(`Ключ интеграции «${c.name}» называется ${c.auth.secret}`, { reason: "NAME" });
    // A per-account passport (amoCRM, Bitrix24): any account of the provider; the window takes it from the fields.
    const pass = passportStateOfContract(c);
    const accountDomain = !!(
      domain &&
      pass?.passport.account &&
      passportAccountFromUrl(pass.passport, domain)
    );
    if (domain && !c.hosts.includes(domain) && !accountDomain)
      throw invalid(
        `Ключ «${c.name}» уходит только на ${c.hosts.join(", ")} — домен ${domain} не из контракта`,
        { reason: "HOST" },
      );
    hosts = [...c.hosts];
  } else if (domain) hosts = [domain];
  else
    throw invalid("Сначала нужен контракт API или домен, куда уйдёт ключ — без него окно не открыть", {
      reason: "NO_HOSTS",
    });
  for (const h of hosts)
    if (egressHostProblem(h, hostsOf(deps)) !== null)
      throw invalid(`Ключ нельзя отправить на ${h}: это не внешний публичный адрес`, { reason: "HOST" });
  return withOrg(deps.pg, orgId, async (tx) => {
    await expireWindows(tx, p.systemId);
    const open = await openWindowFor(tx, p.systemId, env, p.name);
    const same =
      open &&
      open.integrationId === (p.integrationId ?? null) &&
      open.hosts.length === hosts.length &&
      open.hosts.every((h) => hosts.includes(h));
    if (open && same) return { window: open, created: false };
    if (open) await closeWindow(tx, open.id, "cancelled");
    const window = await insertWindow(tx, {
      orgId,
      systemId: p.systemId,
      env,
      name: p.name,
      integrationId: p.integrationId ?? null,
      hosts,
      purpose,
      requestedBy: p.requestedBy,
      runId: p.runId ?? null,
      createdBy: p.userId ?? null,
    });
    return { window, created: true };
  });
}

/** The owner opens a window for an integration of the brief (its contract gives the name and the hosts). */
export async function openIntegrationWindow(
  deps: SecretWindowDeps,
  p: { systemId: string; integrationId: string; env?: Env; userId: string | null },
): Promise<{ window: WindowKeyView; created: boolean }> {
  if (!INTEGRATION_ID.test(p.integrationId)) throw notFound("Интеграция");
  const contract = await latestContract(deps.pg, p.systemId, p.integrationId);
  const integrationName = (await names(deps, p.systemId)).get(p.integrationId) ?? null;
  if (!integrationName) throw notFound("Интеграция в брифе");
  if (!contract)
    throw invalid(
      `Для «${integrationName}» ещё нет контракта API — без него не видно, куда уйдёт ключ. Пришлите в чат ссылку на документацию`,
      { reason: "NO_CONTRACT" },
    );
  const secret = contract.contract.auth.secret;
  if (secret === null) throw invalid(`API «${integrationName}» работает без ключа`, { reason: "KEYLESS" });
  const r = await requestSecret(deps, {
    systemId: p.systemId,
    name: secret.slice("secret://".length),
    purpose: `Подключить «${integrationName}» к системе`,
    integrationId: p.integrationId,
    requestedBy: "user",
    userId: p.userId,
    ...(p.env ? { env: p.env } : {}),
  });
  return { window: await windowWithKey(deps, p.systemId, r.window.id), created: r.created };
}

const closedText: Record<Exclude<WindowRow["status"], "open">, string> = {
  filled: "Это окно ключа уже использовано",
  cancelled: "Окно ключа закрыто — откройте его заново",
  expired: "Окно ключа устарело — откройте его заново",
};

/** An open window with its public key (the key pair is made on the first read; the private half sealed by the KMS). */
export async function windowWithKey(
  deps: SecretWindowDeps,
  systemId: string,
  windowId: string,
): Promise<WindowKeyView> {
  const orgId = await orgOf(deps, systemId);
  const integrationNames = await names(deps, systemId);
  const w = await withOrg(deps.pg, orgId, async (tx) => {
    await expireWindows(tx, systemId);
    const row = await getWindow(tx, systemId, windowId, true);
    if (!row) throw notFound("Окно ключа");
    if (row.status !== "open") throw invalid(closedText[row.status], { reason: "WINDOW_CLOSED" });
    if (row.publicKey) return row;
    if (!deps.kms) throw new ApiError("INTERNAL", "Хранилище ключей платформы недоступно — попробуйте позже");
    const pair = await newWindowKeyPair();
    try {
      const sealed = await sealKey(
        deps.kms,
        windowKeyAad(orgId, row.id),
        pair.privatePkcs8.toString("base64"),
      );
      return await setWindowKey(tx, {
        id: row.id,
        publicKey: pair.publicKey,
        sealedPrivate: sealed.ciphertext,
        wrappedDek: sealed.wrappedDek,
        kekBackend: deps.kms.backend,
        kekName: deps.kms.keyName,
      });
    } finally {
      pair.privatePkcs8.fill(0);
    }
  });
  if (!w?.publicKey) throw invalid(closedText.cancelled, { reason: "WINDOW_CLOSED" });
  const wp = await windowPassport(deps.pg, systemId, w.integrationId);
  return {
    ...windowView(w, w.integrationId ? (integrationNames.get(w.integrationId) ?? null) : null),
    alg: WINDOW_ALG,
    publicKey: w.publicKey,
    context: windowContext(w),
    form: wp ? windowForm(wp.passport) : null,
  };
}

export interface SubmitResult {
  saved: boolean;
  secret: SecretView | null;
  checks: KeyCheckLine[];
  message_ru: string;
}

const dots = (last4: string) => (last4 ? `••••${last4}` : "••••");

function submitMessage(saved: boolean, secret: SecretView | null, checks: readonly KeyCheckLine[]): string {
  const bad = checks.find((c) => !c.ok);
  if (!saved)
    return `Новый ключ не прошёл проверку: ${bad?.message_ru ?? "сервис его не принял"}. Работает прежний ключ ${dots(secret?.last4 ?? "")}`;
  const head = `Ключ сохранён: ${dots(secret?.last4 ?? "")}`;
  if (checks.length === 0) return `${head}. Проверим его, когда появится контракт API интеграции`;
  if (bad)
    return `${head}, но не прошёл проверку: ${bad.message_ru}. Интеграция пока работает на моке — замените ключ`;
  return `${head} и проверен. ${checks.map((c) => c.message_ru).join(" ")}`.trim();
}

/** Submit of a sealed key: the hosts still cover the contracts, then vault.ts opens, checks and stores it. */
export async function submitWindow(
  deps: SecretWindowDeps,
  p: { systemId: string; windowId: string; sealed: unknown; userId: string | null },
): Promise<SubmitResult> {
  if (!isSealedSecret(p.sealed))
    throw invalid("Ключ должен прийти зашифрованным из окна ключа", { reason: "SEAL_FORMAT" });
  const orgId = await orgOf(deps, p.systemId);
  const w = await withOrg(deps.pg, orgId, async (tx) => {
    await expireWindows(tx, p.systemId);
    return getWindow(tx, p.systemId, p.windowId);
  });
  if (!w) throw notFound("Окно ключа");
  if (w.status !== "open") throw invalid(closedText[w.status], { reason: "WINDOW_CLOSED" });
  const contracts = await contractsUsing(deps, p.systemId, w.name);
  const wp = await windowPassport(deps.pg, p.systemId, w.integrationId);
  // A per-account passport takes its host from the account typed into the window (vault rebuilds the contract).
  const extra = wp?.passport.account ? [] : uncoveredHosts(contracts, w.hosts);
  if (extra.length) {
    await withOrg(deps.pg, orgId, (tx) => closeWindow(tx, w.id, "cancelled"));
    throw invalid(
      `Контракт API изменился: ключ уходил бы и на ${extra.join(", ")}, а в окне этого не было. Откройте окно заново`,
      { reason: "HOSTS_CHANGED" },
    );
  }
  const r = await acceptKey(deps, { window: w, sealed: p.sealed, userId: p.userId, contracts, passport: wp });
  const integrationNames = await names(deps, p.systemId);
  const secret = r.binding
    ? secretView(
        r.binding,
        r.binding.integrationId ? (integrationNames.get(r.binding.integrationId) ?? null) : null,
      )
    : null;
  return { saved: r.saved, secret, checks: r.checks, message_ru: submitMessage(r.saved, secret, r.checks) };
}

/** Closes an open window without a key (its key pair is destroyed). */
export async function cancelWindow(
  deps: SecretWindowDeps,
  systemId: string,
  windowId: string,
): Promise<WindowView> {
  const orgId = await orgOf(deps, systemId);
  const integrationNames = await names(deps, systemId);
  const w = await withOrg(deps.pg, orgId, async (tx) => {
    const row = await getWindow(tx, systemId, windowId, true);
    if (!row) throw notFound("Окно ключа");
    if (row.status === "open") await closeWindow(tx, row.id, "cancelled");
    return getWindow(tx, systemId, windowId);
  });
  if (!w) throw notFound("Окно ключа");
  return windowView(w, w.integrationId ? (integrationNames.get(w.integrationId) ?? null) : null);
}

/** Keys of the system, open windows and the brief's integrations that need a key. */
export async function listSecrets(
  deps: SecretWindowDeps,
  systemId: string,
): Promise<{ items: SecretView[]; windows: WindowView[]; needed: NeededKey[] }> {
  const orgId = await orgOf(deps, systemId);
  const brief = await getLatestBrief(deps.db, systemId);
  const integrationNames = new Map((brief?.brief.integrations ?? []).map((i) => [i.id, i.name]));
  const nameOf = (id: string | null) => (id ? (integrationNames.get(id) ?? null) : null);
  const { bindings, windows } = await withOrg(deps.pg, orgId, async (tx) => {
    await expireWindows(tx, systemId);
    return { bindings: await listBindings(tx, systemId), windows: await listOpenWindows(tx, systemId) };
  });
  const contracts = new Map((await latestContracts(deps.pg, systemId)).map((c) => [c.integrationId, c]));
  const needed: NeededKey[] = [];
  for (const i of brief?.brief.integrations ?? []) {
    if (i.direction !== "out") continue;
    const c = contracts.get(i.id)?.contract ?? null;
    const pass = c ? passportStateOfContract(c) : null;
    const secretRef = c?.auth.secret ?? i.secretRef ?? `secret://${i.id}_key`;
    const name = secretRef.slice("secret://".length);
    needed.push({
      integrationId: i.id,
      integrationName: i.name,
      name,
      secretRef,
      hosts: c ? [...c.hosts] : null,
      present: await secretRefExists(deps.pg, systemId, name),
      keyless: c !== null && c.auth.secret === null,
      account:
        pass?.passport.account && !pass.account
          ? { label_ru: pass.passport.account.label_ru, suffixes: [...pass.passport.account.suffixes] }
          : null,
    });
  }
  return {
    items: bindings.map((b) => secretView(b, nameOf(b.integrationId))),
    windows: windows.map((w) => windowView(w, nameOf(w.integrationId))),
    needed,
  };
}

/** Re-check of a stored key by its contracts (the hosts must still be within the window's). */
export async function checkSecret(
  deps: SecretWindowDeps,
  p: { systemId: string; env: Env; name: string },
): Promise<{ secret: SecretView; checks: KeyCheckLine[]; message_ru: string }> {
  if (!SECRET_WINDOW_NAME.test(p.name)) throw notFound("Ключ");
  const orgId = await orgOf(deps, p.systemId);
  const b = await withOrg(deps.pg, orgId, (tx) => getBinding(tx, p.systemId, p.env, p.name));
  if (!b || deps.secrets.get(p.systemId, p.env, p.name) === null) throw notFound("Ключ");
  const contracts = await contractsUsing(deps, p.systemId, p.name);
  const extra = uncoveredHosts(contracts, b.hosts);
  let checks: KeyCheckLine[];
  if (extra.length)
    checks = contracts.map((c) => ({
      integrationId: c.integrationId,
      ok: false,
      status: c.status,
      code: "HOSTS_CHANGED",
      message_ru: `Контракт «${c.contract.name}» обращается к ${extra.join(", ")} — этих адресов не было в окне ключа. Введите ключ заново`,
    }));
  else checks = contracts.length ? await recheckStored(deps, p) : [];
  const v = bindingCheck(checks);
  const row = await withOrg(deps.pg, orgId, (tx) =>
    setBindingCheck(tx, { ...p, status: v.status, code: v.code, message: v.message }),
  );
  const names_ = await names(deps, p.systemId);
  const secret = secretView(row ?? b, b.integrationId ? (names_.get(b.integrationId) ?? null) : null);
  const message_ru =
    checks.length === 0
      ? "Проверять пока нечем: у интеграции нет контракта API"
      : v.status === "ok"
        ? `Ключ ${dots(b.last4)} работает. ${checks.map((c) => c.message_ru).join(" ")}`.trim()
        : `Ключ ${dots(b.last4)} не прошёл проверку: ${v.message ?? ""}`.trim();
  return { secret, checks, message_ru };
}

/** Removal of a key: the value and its metadata go; integrations left without a key go back to the mock. */
export async function removeSecret(
  deps: SecretWindowDeps,
  p: { systemId: string; env: Env; name: string },
): Promise<{ removed: true; integrations: { integrationId: string; status: ContractRow["status"] }[] }> {
  if (!SECRET_WINDOW_NAME.test(p.name)) throw notFound("Ключ");
  const orgId = await orgOf(deps, p.systemId);
  const had = deps.secrets.get(p.systemId, p.env, p.name) !== null;
  const bound = await withOrg(deps.pg, orgId, (tx) => deleteBinding(tx, p.systemId, p.env, p.name));
  if (!had && !bound) throw notFound("Ключ");
  deps.secrets.remove(p.systemId, p.env, p.name);
  await deps.pg`
    delete from platform.secrets_refs where system_id = ${p.systemId} and env = ${p.env} and name = ${p.name}`;
  const left = (["draft", "prod"] as const).some((e) => deps.secrets.get(p.systemId, e, p.name) !== null);
  const out: { integrationId: string; status: ContractRow["status"] }[] = [];
  for (const c of await contractsUsing(deps, p.systemId, p.name)) {
    if (left) {
      out.push({ integrationId: c.integrationId, status: c.status });
      continue;
    }
    await setContractCheck(deps.pg, {
      systemId: p.systemId,
      integrationId: c.integrationId,
      version: c.version,
      status: "mock",
      check: {
        ok: false,
        verified: false,
        code: "SECRET_MISSING",
        status: null,
        message_ru: `Ключ удалён — интеграция «${c.contract.name}» снова работает на моке`,
        problems: [],
      },
    });
    out.push({ integrationId: c.integrationId, status: "mock" });
  }
  return { removed: true, integrations: out };
}
