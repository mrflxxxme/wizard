// Internal secrets of a pilot environment (docs/ops/deploy.md «Пилот: одна кнопка», docs/reviews/impl-notes/
// pilot-bootstrap.md): generated once by tools/deploy/pilot.mjs, kept as ONE encrypted bundle next to the OpenTofu
// state (bucket wizard-tfstate, key wizard/<env>.secrets.enc.json), reused on every later run and after the loss of the
// VM. The only key is the founder's passphrase (GitHub secret WIZARD_STATE_PASSPHRASE, also in his password manager).
// node:crypto only: scrypt → AES-256-GCM, the environment name bound as associated data (a staging bundle never opens
// as prod). The SSH key pair is written in the OpenSSH format by hand, so no ssh-keygen is needed to make it.
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";

export const BUNDLE_FORMAT = "wizard-secrets-v1";
/** scrypt cost of the bundle key: 128 MiB, ≈ 0.3–0.5 s on a runner — a stolen bundle is expensive to brute-force. */
export const KDF = { name: "scrypt", N: 2 ** 17, r: 8, p: 1 };
export const MIN_PASSPHRASE = 16;

const hex = (bytes) => (rand) => rand(bytes).toString("hex");

/**
 * Generated values of the bundle and how they are made. Names are the env names the cluster reads
 * (Secrets wizard-platform-env, wizard-postgres, wizard-pgbouncer; infra/helm/wizard/values.yaml#secrets).
 */
export const GENERATED = {
  // PostgreSQL role `wizard`; hex keeps the DB URL free of escaping.
  POSTGRES_PASSWORD: hex(24),
  // ≥ 32 bytes: HKDF master of OTP pepper, connector secrets file, import/export sealing (apps/platform-api config).
  WIZARD_SECRETS_KEY: hex(32),
  WIZARD_PREVIEW_SECRET: hex(32),
  WIZARD_INTERNAL_TOKEN: hex(32),
  // WAL-G libsodium key: 32 bytes as 64 hex (WALG_LIBSODIUM_KEY_TRANSFORM=hex in the chart).
  WALG_LIBSODIUM_KEY: hex(32),
  // rclone crypt password of the .data copy (pg-ops data-sync / data-restore).
  WIZARD_DATA_BACKUP_KEY: hex(32),
};

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const sshString = (b) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return Buffer.concat([u32(buf.length), buf]);
};

/**
 * Ed25519 key pair of the admin SSH access: {privateKey: OpenSSH PEM ("openssh-key-v1", unencrypted — it lives only
 * inside the encrypted bundle and in a 0600 file of the job), publicKey: "ssh-ed25519 AAAA… <comment>"}.
 */
export function sshKeyPair(comment, rand = randomBytes) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const type = "ssh-ed25519";
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)]);
  const check = rand(4);
  let priv = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const pad = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = body.toString("base64").replace(/.{1,70}/g, "$&\n");
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${type} ${pubBlob.toString("base64")} ${comment}`,
  };
}

/**
 * Idempotent bundle: every value already present is kept as is (never regenerated — the WAL archive, the .data copy
 * and every session depend on them); only missing ones are generated. Returns {bundle, added: [names]}.
 */
export function ensureBundle(existing, env, { rand = randomBytes, now = () => new Date() } = {}) {
  if (existing && existing.env !== env) throw new Error(`bundle of ${existing.env} used for ${env}`);
  const bundle = existing
    ? { ...existing, secrets: { ...existing.secrets } }
    : { v: 1, env, createdAt: now().toISOString(), secrets: {} };
  const added = [];
  for (const [name, make] of Object.entries(GENERATED)) {
    if (!bundle.secrets[name]) {
      bundle.secrets[name] = make(rand);
      added.push(name);
    }
  }
  if (!bundle.secrets.SSH_PRIVATE_KEY || !bundle.secrets.SSH_PUBLIC_KEY) {
    const k = sshKeyPair(`wizard-pilot-${env}`, rand);
    bundle.secrets.SSH_PRIVATE_KEY = k.privateKey;
    bundle.secrets.SSH_PUBLIC_KEY = k.publicKey;
    added.push("SSH_PRIVATE_KEY", "SSH_PUBLIC_KEY");
  }
  return { bundle, added };
}

const aad = (env) => Buffer.from(`${BUNDLE_FORMAT}:${env}`);

function deriveKey(passphrase, salt, kdf) {
  if (kdf.name !== "scrypt") throw new Error(`unknown kdf ${kdf.name}`);
  return scryptSync(Buffer.from(passphrase, "utf8"), salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r + 1024 * 1024,
  });
}

export function assertPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE)
    throw new Error(`WIZARD_STATE_PASSPHRASE: нужен пароль не короче ${MIN_PASSPHRASE} символов`);
}

/** Encrypted envelope (JSON text) of a bundle. */
export function encryptBundle(bundle, passphrase, { rand = randomBytes, kdf = KDF } = {}) {
  assertPassphrase(passphrase);
  const salt = rand(16);
  const iv = rand(12);
  const key = deriveKey(passphrase, salt, kdf);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(bundle.env));
  const data = Buffer.concat([c.update(JSON.stringify(bundle), "utf8"), c.final()]);
  return `${JSON.stringify(
    {
      format: BUNDLE_FORMAT,
      env: bundle.env,
      kdf: { ...kdf, salt: salt.toString("base64") },
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    },
    null,
    2,
  )}\n`;
}

/** Opens an envelope of `env`; a wrong passphrase or a tampered file is an error, never an empty bundle. */
export function decryptBundle(text, passphrase, env) {
  let e;
  try {
    e = JSON.parse(String(text));
  } catch {
    throw new Error("файл ключей повреждён (не JSON)");
  }
  if (e.format !== BUNDLE_FORMAT) throw new Error(`неизвестный формат файла ключей: ${e.format}`);
  if (e.env !== env) throw new Error(`файл ключей окружения ${e.env}, а не ${env}`);
  const key = deriveKey(passphrase, Buffer.from(e.kdf.salt, "base64"), e.kdf);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAAD(aad(env));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  let plain;
  try {
    plain = Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new Error(
      "не удалось расшифровать ключи: WIZARD_STATE_PASSPHRASE не тот, что при первом запуске (ничего не перезаписано)",
    );
  }
  const bundle = JSON.parse(plain);
  if (bundle.env !== env) throw new Error(`файл ключей окружения ${bundle.env}, а не ${env}`);
  return bundle;
}

/** Values that must never appear in logs (GitHub ::add-mask::), multi-line keys line by line. */
export function secretValues(bundle) {
  return Object.values(bundle.secrets)
    .flatMap((v) => String(v).split("\n"))
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && !s.startsWith("-----"));
}

/** `KEY=value` lines of a kubectl --from-env-file file; empty values are left out. */
export function envFile(entries) {
  const lines = [];
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined || v === null || v === "") continue;
    const s = String(v);
    if (/[\r\n]/.test(s)) throw new Error(`${k}: значение не должно содержать перевод строки`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`bad env name ${k}`);
    lines.push(`${k}=${s}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Optional platform settings passed through as they are (GitHub secrets/variables of the same name); empty ones are
 * left out. Models (D26, M2-32): keys, base URLs of the providers and the default build tier.
 */
export const PLATFORM_PASSTHROUGH = [
  "CLOUDRU_API_KEY",
  "ZAI_API_KEY",
  "CLOUDRU_BASE_URL",
  "ZAI_BASE_URL",
  "YANDEX_API_KEY",
  "YANDEX_FOLDER_ID",
  "YANDEX_BASE_URL",
  "WIZARD_BUILD_DEFAULT_TIER",
  // D75: platform model spend per Moscow day (default 700 ₽); raised only by the founder.
  "WIZARD_LLM_DAILY_CAP_RUB",
  // B2-01, B2-04: staff reserve of the daily cap (200 ₽), eval daily cap (300 ₽), beta v2 budget (1 000 ₽ since 06.10).
  "WIZARD_LLM_STAFF_RESERVE_RUB",
  "WIZARD_LLM_EVAL_DAILY_CAP_RUB",
  "WIZARD_B2_BUDGET_RUB",
  "WIZARD_B2_BUDGET_SINCE",
  "WIZARD_SMTP_HOST",
  "WIZARD_SMTP_PORT",
  "WIZARD_SMTP_USER",
  "WIZARD_SMTP_PASSWORD",
  "WIZARD_SMTP_FROM",
  "WIZARD_SMTP_TLS",
  "WIZARD_MAIL_TRANSPORT",
  "WIZARD_MAIL_API_BASE",
  "WIZARD_TELEGRAM_BOT_TOKEN",
  "WIZARD_PLATFORM_YOOKASSA_SHOP_ID",
  "WIZARD_PLATFORM_YOOKASSA_SECRET_KEY",
  "WIZARD_RECEIPT_VAT_CODE",
];

/** Founder alert webhook: the Telegram bot form (token + chat) or a ready URL (docs/ops/deploy.md «Алерты пилота»). */
export function alertSettings(inputs) {
  const token = inputs.WIZARD_OPS_ALERT_TELEGRAM_TOKEN;
  if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token))
    throw new Error("WIZARD_OPS_ALERT_TELEGRAM_TOKEN: нужен токен бота вида 123456:ABC…");
  const url = token ? `https://api.telegram.org/bot${token}/sendMessage` : inputs.WIZARD_OPS_ALERT_URL || "";
  if (url && !url.startsWith("https://")) throw new Error("WIZARD_OPS_ALERT_URL: нужен https-адрес");
  return {
    WIZARD_OPS_ALERT_URL: url,
    WIZARD_OPS_ALERT_CHAT_ID: url ? inputs.WIZARD_OPS_ALERT_CHAT_ID || "" : "",
    WIZARD_OPS_ALERT_EMAIL: inputs.WIZARD_OPS_ALERT_EMAIL || inputs.WIZARD_FOUNDER_EMAIL || "",
  };
}

/**
 * Contents of the four cluster Secrets of the pilot from the bundle, the tofu outputs (buckets and their keys) and the
 * founder's inputs: {platformEnv, postgresEnv, userlist, dnsSolverEnv} (tools/deploy/infra.mjs clusterSecrets).
 */
export function clusterSecretFiles({ bundle, outputs, inputs }) {
  const s = bundle.secrets;
  const buckets = outputs.env?.buckets ?? {};
  // The founder's Timeweb S3 account key (GitHub secrets AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) wins over the keys
  // the API reports per bucket: those were refused by S3 on the first live apply (SignatureDoesNotMatch).
  const account =
    inputs.WIZARD_S3_ACCOUNT_KEY_ID && inputs.WIZARD_S3_ACCOUNT_SECRET
      ? {
          access_key: inputs.WIZARD_S3_ACCOUNT_KEY_ID.trim(),
          secret_key: inputs.WIZARD_S3_ACCOUNT_SECRET.trim(),
        }
      : null;
  const keys = account ? { files: account, backups: account } : (outputs.s3_keys ?? {});
  for (const b of ["files", "backups"]) {
    if (!buckets[b] || !keys[b]?.access_key || !keys[b]?.secret_key)
      throw new Error(`tofu outputs: нет бакета ${b} или его ключей`);
  }
  const pass = Object.fromEntries(PLATFORM_PASSTHROUGH.map((n) => [n, inputs[n]]));
  const platformEnv = envFile({
    WIZARD_DB_URL: `postgres://wizard:${s.POSTGRES_PASSWORD}@wizard-pgbouncer:6432/wizard`,
    WIZARD_SECRETS_KEY: s.WIZARD_SECRETS_KEY,
    WIZARD_PREVIEW_SECRET: s.WIZARD_PREVIEW_SECRET,
    WIZARD_INTERNAL_TOKEN: s.WIZARD_INTERNAL_TOKEN,
    // The invite-only pilot (registration: invite) lets the founder sign in without an invitation.
    WIZARD_FOUNDER_EMAIL: (inputs.WIZARD_FOUNDER_EMAIL ?? "").trim().toLowerCase(),
    WIZARD_S3_BUCKET: buckets.files,
    WIZARD_S3_ACCESS_KEY_ID: keys.files.access_key,
    WIZARD_S3_SECRET_ACCESS_KEY: keys.files.secret_key,
    ...pass,
  });
  const postgresEnv = envFile({
    POSTGRES_PASSWORD: s.POSTGRES_PASSWORD,
    WALG_LIBSODIUM_KEY: s.WALG_LIBSODIUM_KEY,
    AWS_ACCESS_KEY_ID: keys.backups.access_key,
    AWS_SECRET_ACCESS_KEY: keys.backups.secret_key,
    WIZARD_DATA_BACKUP_KEY: s.WIZARD_DATA_BACKUP_KEY,
    ...alertSettings(inputs),
  });
  // PgBouncer auth_file: a plain password lets PgBouncer do SCRAM both to clients and to the server.
  const userlist = `"wizard" "${s.POSTGRES_PASSWORD}"\n`;
  const dnsSolverEnv = envFile({ TWC_TOKEN: inputs.TWC_TOKEN });
  return { platformEnv, postgresEnv, userlist, dnsSolverEnv };
}
