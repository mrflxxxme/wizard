// V3-33 BYOK of platform-api: the service of a process (flag and KMS from env) shared by the HTTP routes and the run
// engines (API in-process and apps/worker), so a run's router gets the org's own key without extra wiring.
import type { ByokResolver } from "@wizard/llm";
import type postgres from "postgres";
import type { SecretStore } from "../secrets/store.js";
import { byokConfigFromEnv, type Env, kmsOf } from "./config.js";
import { ByokService } from "./service.js";

export { type ByokConfig, byokConfigFromEnv, byokOff, kmsOf } from "./config.js";
export { BYOK_CONSENT, type ByokConsentText, consentSha256 } from "./consent.js";
export { KmsError, keyAad, LocalTransit, OpenBaoTransit, openKey, sealKey, type TransitKms } from "./kms.js";
export { byokRoutes } from "./routes.js";
export {
  BYOK_MAX_KEYS,
  type ByokKeyView,
  ByokService,
  type ByokServiceOptions,
  type ByokState,
} from "./service.js";

const services = new WeakMap<object, ByokService>();

/** The BYOK service of this connection, from env (WIZARD_BYOK, WIZARD_BYOK_ORGS, WIZARD_BYOK_KMS, WIZARD_OPENBAO_*). */
export function byokServiceOf(
  pg: postgres.Sql,
  secrets: SecretStore | undefined,
  env: Env = process.env,
): ByokService {
  const hit = services.get(pg);
  if (hit) return hit;
  const config = byokConfigFromEnv(env);
  const svc = new ByokService({ pg, config, kms: kmsOf(config, secrets) });
  services.set(pg, svc);
  return svc;
}

/** The router hook of the run engines; null when the feature is off for everyone (the default until V3-35). */
export function byokResolverOf(
  pg: postgres.Sql,
  secrets: SecretStore | undefined,
  env: Env = process.env,
): ByokResolver | null {
  const svc = byokServiceOf(pg, secrets, env);
  return svc.off ? null : svc.resolver();
}
