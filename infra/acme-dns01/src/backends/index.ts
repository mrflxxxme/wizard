// DNS backends of the solver, selected by DNS_PROVIDER (the provider layer of the deploy: infra/helm/providers/*.yaml).
import { readFileSync } from "node:fs";
import type { DnsBackend } from "../webhook.js";
import { CloudruDns } from "./cloudru.js";
import { TimewebDns } from "./timeweb.js";

export const DNS_PROVIDERS = ["timeweb", "cloudru"] as const;
export type DnsProvider = (typeof DNS_PROVIDERS)[number];

/** NAME or NAME_FILE (a mounted Secret file) from the environment. */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const file = env[`${name}_FILE`];
  return (file ? readFileSync(file, "utf8") : (env[name] ?? "")).trim();
}

/** Backend of DNS_PROVIDER with its credentials: timeweb → TWC_TOKEN; cloudru → CLOUDRU_PROJECT_ID/KEY_ID/KEY_SECRET. */
export function createBackend(
  env: Readonly<Record<string, string | undefined>>,
  f?: typeof fetch,
): DnsBackend {
  const provider = env.DNS_PROVIDER ?? "";
  if (provider === "timeweb") {
    return new TimewebDns({ token: envValue(env, "TWC_TOKEN"), ...(f ? { fetch: f } : {}) });
  }
  if (provider === "cloudru") {
    return new CloudruDns({
      projectId: envValue(env, "CLOUDRU_PROJECT_ID"),
      keyId: envValue(env, "CLOUDRU_KEY_ID"),
      secret: envValue(env, "CLOUDRU_KEY_SECRET"),
      ...(f ? { fetch: f } : {}),
    });
  }
  throw new Error(`DNS_PROVIDER must be one of ${DNS_PROVIDERS.join(", ")}`);
}
