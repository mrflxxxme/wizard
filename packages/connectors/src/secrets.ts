// Secrets are referenced only as secret://<name> (connector-interface.md §2 «Секреты»).
import { ConnectorError } from "./errors.js";
import type { SecretReader } from "./types.js";

export const SECRET_REF_PREFIX = "secret://";
const SECRET_NAME_RE = /^[a-z0-9_]+$/;
export const SECRET_CACHE_MAX_MS = 5 * 60_000;

export function secretRef(name: string): string {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`invalid secret name: ${name}`);
  return `${SECRET_REF_PREFIX}${name}`;
}

/** `secret://name` → `name`; anything else → null. */
export function parseSecretRef(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith(SECRET_REF_PREFIX)) return null;
  const name = ref.slice(SECRET_REF_PREFIX.length);
  return SECRET_NAME_RE.test(name) ? name : null;
}

/** M0 storage: `.env` variable WIZARD_SECRET_<SYSTEMID>_<NAME>. */
export function secretEnvVar(systemId: string, name: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `WIZARD_SECRET_${norm(systemId)}_${norm(name)}`;
}

export function missingSecret(name: string): ConnectorError {
  return new ConnectorError("SECRET_MISSING", `Нужны ключи: не задан секрет «${name}»`);
}

export function envSecretReader(systemId: string, env: NodeJS.ProcessEnv = process.env): SecretReader {
  return {
    async get(name) {
      const value = env[secretEnvVar(systemId, name)];
      if (!value) throw missingSecret(name);
      return value;
    },
  };
}

export function staticSecretReader(values: Record<string, string>): SecretReader {
  return {
    async get(name) {
      const value = values[name];
      if (!value) throw missingSecret(name);
      return value;
    },
  };
}

/** Caches values for at most `ttlMs` (capped at 5 minutes). */
export function cachedSecretReader(
  inner: SecretReader,
  ttlMs = SECRET_CACHE_MAX_MS,
  now: () => number = Date.now,
): SecretReader {
  const ttl = Math.min(ttlMs, SECRET_CACHE_MAX_MS);
  const cache = new Map<string, { value: string; at: number }>();
  return {
    async get(name) {
      const hit = cache.get(name);
      if (hit && now() - hit.at < ttl) return hit.value;
      const value = await inner.get(name);
      cache.set(name, { value, at: now() });
      return value;
    },
  };
}
