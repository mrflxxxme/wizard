// Cryptography of the key window (V3-21; security/data-boundary.yaml#secret_window.crypto): every window has its own
// P-256 key pair. The browser (apps/platform-web/src/screens/v3/keys/seal.ts, WebCrypto) makes an ephemeral P-256 pair,
// derives the shared secret with the window's public key (ECDH), expands it with HKDF-SHA-256 (salt = window id, info =
// version + context) into an AES-256-GCM key and encrypts the key with the context as additional data — the context binds
// the ciphertext to the window, the system, the env and the name. Only the platform can open it: the private half of the
// window is sealed by the KMS and unsealed for one opening inside the secret store (vault.ts).
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

/** Format version of a sealed key (also the HKDF info prefix and the context prefix). */
export const WINDOW_VERSION = "wz-key-window/v1";
/** The algorithm a sealed key names. */
export const WINDOW_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";
/** Ciphertext limit: a key of ≤ 4096 bytes plus the GCM tag, base64url. */
export const SEALED_MAX_CT = 6000;

const B64URL = /^[A-Za-z0-9_-]+$/;
const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;

/** The public half of a window (JWK, only what the browser needs). */
export interface WindowPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** What the browser sends: the ephemeral public key, the nonce and the ciphertext (base64url). */
export interface SealedSecret {
  v: 1;
  alg: typeof WINDOW_ALG;
  epk: WindowPublicKey;
  iv: string;
  ct: string;
}

/** A value-free failure of opening (bad point, wrong window, tampered ciphertext): never carries input. */
export class SealError extends Error {
  constructor() {
    super("SEAL_INVALID");
    this.name = "SealError";
  }
}

/** The context a sealed key is bound to (GCM additional data and HKDF info). */
export const windowContext = (w: { id: string; systemId: string; env: string; name: string }): string =>
  `${WINDOW_VERSION}:${w.id}:${w.systemId}:${w.env}:${w.name}`;

const b64url = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b as Uint8Array).toString("base64url");
const unb64url = (s: string): Buffer => {
  if (!B64URL.test(s)) throw new SealError();
  return Buffer.from(s, "base64url");
};

const isPoint = (k: unknown): k is WindowPublicKey => {
  const o = k as Record<string, unknown> | null;
  return (
    !!o &&
    o.kty === "EC" &&
    o.crv === "P-256" &&
    typeof o.x === "string" &&
    typeof o.y === "string" &&
    B64URL.test(o.x) &&
    B64URL.test(o.y) &&
    o.x.length === 43 &&
    o.y.length === 43
  );
};

/** Shape check of a submitted sealed key (no cryptography). */
export function isSealedSecret(v: unknown): v is SealedSecret {
  const o = v as Record<string, unknown> | null;
  return (
    !!o &&
    o.v === 1 &&
    o.alg === WINDOW_ALG &&
    isPoint(o.epk) &&
    typeof o.iv === "string" &&
    B64URL.test(o.iv) &&
    o.iv.length === 16 &&
    typeof o.ct === "string" &&
    B64URL.test(o.ct) &&
    o.ct.length >= 24 &&
    o.ct.length <= SEALED_MAX_CT
  );
}

/** A fresh window key pair: the public JWK for the browser, the private PKCS#8 bytes for the KMS to seal. */
export async function newWindowKeyPair(): Promise<{ publicKey: WindowPublicKey; privatePkcs8: Buffer }> {
  const kp = (await subtle.generateKey(CURVE, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
  const jwk = await subtle.exportKey("jwk", kp.publicKey);
  const privatePkcs8 = Buffer.from(await subtle.exportKey("pkcs8", kp.privateKey));
  if (!isPoint(jwk)) throw new SealError();
  return { publicKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, privatePkcs8 };
}

async function aesKey(
  priv: webcrypto.CryptoKey,
  pub: webcrypto.CryptoKey,
  salt: string,
  context: string,
  usage: "encrypt" | "decrypt",
): Promise<webcrypto.CryptoKey> {
  const shared = await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: Buffer.from(salt, "utf8"),
      info: Buffer.from(`${WINDOW_VERSION}|${context}`, "utf8"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/**
 * Opens a sealed key with the window's private key (PKCS#8). `salt` is the window id, `context` its windowContext().
 * Throws SealError (no detail) on any failure; the caller wipes `privatePkcs8`.
 */
export async function openSealedSecret(
  privatePkcs8: Buffer,
  sealed: SealedSecret,
  salt: string,
  context: string,
): Promise<string> {
  try {
    const priv = await subtle.importKey("pkcs8", privatePkcs8, CURVE, false, ["deriveBits"]);
    const epk = await subtle.importKey("jwk", { ...sealed.epk, ext: true }, CURVE, false, []);
    const key = await aesKey(priv, epk, salt, context, "decrypt");
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: unb64url(sealed.iv), additionalData: Buffer.from(context, "utf8") },
      key,
      unb64url(sealed.ct),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new SealError();
  }
}

/**
 * The server-side mirror of the browser's sealing (tests and tools only; the page uses screens/v3/keys/seal.ts — the
 * same steps over window.crypto.subtle).
 */
export async function sealForWindow(
  publicKey: WindowPublicKey,
  value: string,
  salt: string,
  context: string,
): Promise<SealedSecret> {
  const eph = (await subtle.generateKey(CURVE, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
  const pub = await subtle.importKey("jwk", { ...publicKey, ext: true }, CURVE, false, []);
  const key = await aesKey(eph.privateKey, pub, salt, context, "encrypt");
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: Buffer.from(context, "utf8") },
    key,
    Buffer.from(value, "utf8"),
  );
  const epk = await subtle.exportKey("jwk", eph.publicKey);
  if (!isPoint(epk)) throw new SealError();
  return {
    v: 1,
    alg: WINDOW_ALG,
    epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y },
    iv: b64url(iv),
    ct: b64url(ct),
  };
}
