// Key material of end-user login (runtime.yaml#auth.anti_abuse, #logging, postgres.system_tables._w_otp; L3-25):
// OTP pepper, destination/IP HMAC keys and the sealing key of challenge ids and OIDC state are derived from
// WIZARD_SECRETS_KEY with HKDF; nothing of it is stored in the database.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { StartupError } from "../env.js";

export interface AuthKeys {
  /** HMAC(pepper, …) of OTP codes. */
  otp(parts: readonly string[]): Buffer;
  /** Keyed hash of an email/phone: the same destination hashes alike in every system (global limits). */
  destination(value: string): Buffer;
  /** Keyed hash of the client network (IPv4 address, IPv6 /64); null when the address is unknown. */
  ip(address: string | null): Buffer | null;
  /** runtime.yaml#logging: userIdHash = first 12 hex of HMAC-SHA256(user_id). */
  userIdHash(userId: string): string;
  /** AES-256-GCM sealed JSON bound to `aad` (challenge ids, OIDC state cookie), base64url. */
  seal(value: unknown, aad: string): string;
  /** null when the blob is malformed, tampered with or bound to another `aad`. */
  unseal<T>(blob: string, aad: string): T | null;
}

const sub = (master: Buffer, info: string) =>
  Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `wizard-runtime-auth:${info}`, 32));

/**
 * Keys from WIZARD_SECRETS_KEY. Without it the key is random per process (codes and challenges die with it; global
 * limits then count per process); with NODE_ENV=production a missing or short key refuses to start.
 */
export function authKeys(secretsKey: string | undefined, nodeEnv: string | undefined): AuthKeys {
  if (nodeEnv === "production" && (!secretsKey || secretsKey.length < 32)) {
    throw new StartupError("WIZARD_SECRETS_KEY (≥ 32 chars) is required with NODE_ENV=production");
  }
  const master = secretsKey ? Buffer.from(secretsKey, "utf8") : randomBytes(32);
  const pepper = sub(master, "otp-pepper");
  const dest = sub(master, "destination");
  const ipKey = sub(master, "ip");
  const userKey = sub(master, "user-id");
  const sealKey = sub(master, "seal");
  const hmac = (key: Buffer, parts: readonly string[]) => {
    const h = createHmac("sha256", key);
    parts.forEach((p, i) => {
      if (i > 0) h.update("\0");
      h.update(p, "utf8");
    });
    return h.digest();
  };
  return {
    otp: (parts) => hmac(pepper, parts),
    destination: (value) => hmac(dest, [value]),
    ip: (address) => {
      const net = clientNetwork(address);
      return net === null ? null : hmac(ipKey, [net]);
    },
    userIdHash: (userId) => hmac(userKey, [userId]).toString("hex").slice(0, 12),
    seal(value, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", sealKey, iv);
      c.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
    },
    unseal<T>(blob: string, aad: string): T | null {
      if (!/^[A-Za-z0-9_-]{40,4096}$/.test(blob)) return null;
      const raw = Buffer.from(blob, "base64url");
      if (raw.length < 29) return null;
      try {
        const d = createDecipheriv("aes-256-gcm", sealKey, raw.subarray(0, 12));
        d.setAAD(Buffer.from(aad, "utf8"));
        d.setAuthTag(raw.subarray(12, 28));
        const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
        return JSON.parse(pt.toString("utf8")) as T;
      } catch {
        return null;
      }
    },
  };
}

/** IPv4 as is, IPv6 by its /64 (runtime.yaml#auth.anti_abuse); IPv4-mapped IPv6 → IPv4. */
export function clientNetwork(address: string | null): string | null {
  if (!address) return null;
  const a = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  const kind = isIP(a);
  if (kind === 4) return a;
  if (kind !== 6) return null;
  const [head = "", tail = ""] = a.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = a.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g || "0", 16).toString(16))
    .join(":")}::/64`;
}

export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sameText(a: string, b: string): boolean {
  return sameBytes(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
