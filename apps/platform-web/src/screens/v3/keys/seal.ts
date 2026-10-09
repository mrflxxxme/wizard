// Encryption of a key in the browser (V3-21; security/data-boundary.yaml#secret_window): WebCrypto only — an ephemeral
// P-256 pair, ECDH with the window's public key, HKDF-SHA-256 (salt = window id, info = version + context) into an
// AES-256-GCM key, the context as additional data. The key never leaves the page in clear; the platform opens the
// ciphertext only inside its secret store (apps/platform-api/src/secrets-v3/crypto.ts mirrors these steps).

export const WINDOW_VERSION = "wz-key-window/v1";
export const WINDOW_ALG = "ECDH-ES+HKDF-SHA256+A256GCM";

export interface WindowPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface SealedSecret {
  v: 1;
  alg: typeof WINDOW_ALG;
  epk: WindowPublicKey;
  iv: string;
  ct: string;
}

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;
const utf8 = (s: string) => new TextEncoder().encode(s);

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** WebCrypto is there (a secure context: https or localhost). */
export function canSeal(): boolean {
  return typeof globalThis.crypto?.subtle?.deriveBits === "function";
}

/**
 * Encrypts `value` for the window (`windowId`, its public key and context from GET …/secret-windows/:id). Returns the
 * body of POST …/submit.
 */
export async function sealSecret(
  w: { id: string; publicKey: WindowPublicKey; context: string },
  value: string,
): Promise<SealedSecret> {
  const subtle = globalThis.crypto.subtle;
  const eph = (await subtle.generateKey(CURVE, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = await subtle.importKey("jwk", { ...w.publicKey, ext: true }, CURVE, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: pub }, eph.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(w.id), info: utf8(`${WINDOW_VERSION}|${w.context}`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(w.context) }, key, utf8(value));
  const epk = (await subtle.exportKey("jwk", eph.publicKey)) as JsonWebKey;
  if (typeof epk.x !== "string" || typeof epk.y !== "string") throw new Error("ECDH export failed");
  return {
    v: 1,
    alg: WINDOW_ALG,
    epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y },
    iv: b64url(iv),
    ct: b64url(ct),
  };
}
