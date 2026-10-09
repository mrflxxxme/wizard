// Envelope encryption of BYOK keys (V3-33; docs/research/2026-10-08-v3-research.md §6; deploy.yaml#secrets.kms): every
// key is sealed with its own data key (AES-256-GCM, bound to the org and the key id), the data key is wrapped by a KEK
// that never leaves the KMS — OpenBao Transit in the cloud, the local secret store (SecretStore, WIZARD_SECRETS_KEY) on
// dev stands and in tests. The database holds the ciphertext and the wrapped data key only.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretStore } from "../secrets/store.js";

/** The Transit surface the BYOK store needs (OpenBao `transit/datakey/plaintext`, `transit/decrypt`). */
export interface TransitKms {
  readonly backend: "local" | "openbao";
  readonly keyName: string;
  /** A fresh 256-bit data key: plaintext for one sealing, `wrapped` for the database. */
  generateDataKey(): Promise<{ plaintext: Buffer; wrapped: string }>;
  /** Unwraps a data key; throws KmsError (no detail) on any failure. */
  decryptDataKey(wrapped: string): Promise<Buffer>;
}

/** A value-free failure of the KMS (never carries a response body, a token or a key). */
export class KmsError extends Error {
  constructor() {
    super("KMS_UNAVAILABLE");
    this.name = "KmsError";
  }
}

const gcmSeal = (key: Buffer, aad: string, plain: Buffer): string => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
};

const gcmOpen = (key: Buffer, aad: string, sealed: string): Buffer => {
  const buf = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
};

/**
 * Dev and test implementation of the same interface: the KEK is a random 256-bit platform secret of SecretStore
 * (`platform/byok/kek-<name>`, encrypted at rest with WIZARD_SECRETS_KEY); wrapped data keys look like `local:v1:…`.
 */
export class LocalTransit implements TransitKms {
  readonly backend = "local" as const;
  #kek: Buffer | undefined;
  constructor(
    private readonly secrets: SecretStore,
    readonly keyName = "byok",
  ) {}

  #key(): Buffer {
    if (this.#kek) return this.#kek;
    const path = `byok/kek-${this.keyName}`;
    let b64 = this.secrets.getPlatform(path);
    if (!b64) {
      b64 = randomBytes(32).toString("base64");
      this.secrets.putPlatform(path, b64);
    }
    this.#kek = Buffer.from(b64, "base64");
    return this.#kek;
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; wrapped: string }> {
    const plaintext = randomBytes(32);
    try {
      return { plaintext, wrapped: `local:v1:${gcmSeal(this.#key(), "byok-dek", plaintext)}` };
    } catch {
      throw new KmsError();
    }
  }

  async decryptDataKey(wrapped: string): Promise<Buffer> {
    const m = /^local:v1:(.+)$/.exec(wrapped);
    if (!m?.[1]) throw new KmsError();
    try {
      return gcmOpen(this.#key(), "byok-dek", m[1]);
    } catch {
      throw new KmsError();
    }
  }
}

export interface OpenBaoOptions {
  /** WIZARD_OPENBAO_ADDR, e.g. https://openbao.internal:8200 */
  addr: string;
  /** WIZARD_OPENBAO_TOKEN: a token whose policy allows only transit/datakey and transit/decrypt of this key. */
  token: string;
  /** WIZARD_OPENBAO_TRANSIT_MOUNT (default transit). */
  mount?: string;
  /** WIZARD_BYOK_TRANSIT_KEY (default wizard-byok): `bao write -f transit/keys/wizard-byok type=aes256-gcm96`. */
  keyName?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** OpenBao Transit over HTTP (MPL-2.0 server, no client library): datakey/plaintext and decrypt. */
export class OpenBaoTransit implements TransitKms {
  readonly backend = "openbao" as const;
  readonly keyName: string;
  readonly #o: OpenBaoOptions;
  constructor(o: OpenBaoOptions) {
    this.#o = o;
    this.keyName = o.keyName ?? "wizard-byok";
  }

  async #post(
    op: "datakey/plaintext" | "decrypt",
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const mount = encodeURIComponent(this.#o.mount ?? "transit");
    const url = `${this.#o.addr.replace(/\/+$/, "")}/v1/${mount}/${op}/${encodeURIComponent(this.keyName)}`;
    try {
      const res = await (this.#o.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "x-vault-token": this.#o.token, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new KmsError();
      const data = ((await res.json()) as { data?: Record<string, unknown> }).data;
      if (!data) throw new KmsError();
      return data;
    } catch {
      throw new KmsError();
    }
  }

  async generateDataKey(): Promise<{ plaintext: Buffer; wrapped: string }> {
    const d = await this.#post("datakey/plaintext", { bits: 256 });
    if (
      typeof d.plaintext !== "string" ||
      typeof d.ciphertext !== "string" ||
      !d.ciphertext.startsWith("vault:v")
    )
      throw new KmsError();
    const plaintext = Buffer.from(d.plaintext, "base64");
    if (plaintext.length !== 32) throw new KmsError();
    return { plaintext, wrapped: d.ciphertext };
  }

  async decryptDataKey(wrapped: string): Promise<Buffer> {
    if (!wrapped.startsWith("vault:v")) throw new KmsError();
    const d = await this.#post("decrypt", { ciphertext: wrapped });
    if (typeof d.plaintext !== "string") throw new KmsError();
    const key = Buffer.from(d.plaintext, "base64");
    if (key.length !== 32) throw new KmsError();
    return key;
  }
}

/** Sealed key as stored in platform.byok_keys. */
export interface SealedKey {
  ciphertext: string;
  wrappedDek: string;
}

/** AAD of a key: binds the ciphertext to its org and row (a copied row does not open elsewhere). */
export const keyAad = (orgId: string, keyId: string): string => `byok:${orgId}:${keyId}`;

/** Seals a key with a fresh data key; the plaintext data key is wiped before returning. */
export async function sealKey(kms: TransitKms, aad: string, key: string): Promise<SealedKey> {
  const dek = await kms.generateDataKey();
  try {
    return { ciphertext: gcmSeal(dek.plaintext, aad, Buffer.from(key, "utf8")), wrappedDek: dek.wrapped };
  } finally {
    dek.plaintext.fill(0);
  }
}

/** Opens a sealed key; throws KmsError (no detail) when the KMS or the authentication tag refuses. */
export async function openKey(kms: TransitKms, aad: string, s: SealedKey): Promise<string> {
  const dek = await kms.decryptDataKey(s.wrappedDek);
  try {
    return gcmOpen(dek, aad, s.ciphertext).toString("utf8");
  } catch {
    throw new KmsError();
  } finally {
    dek.fill(0);
  }
}
