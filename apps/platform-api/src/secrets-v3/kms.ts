// The KMS of key windows (V3-21): the same TransitKms as BYOK (V3-33, byok/kms.ts) with its own key — OpenBao Transit
// `wizard-secret-window` in the cloud (WIZARD_SECRET_WINDOW_TRANSIT_KEY), the local KEK `platform/byok/kek-secret-window`
// of SecretStore on dev stands and in tests. The backend choice and the OpenBao address and token are BYOK's
// (WIZARD_BYOK_KMS, WIZARD_OPENBAO_*): one KMS of the platform, a separate key per purpose.
import { byokConfigFromEnv, type Env } from "../byok/config.js";
import { LocalTransit, OpenBaoTransit, type TransitKms } from "../byok/kms.js";
import type { SecretStore } from "../secrets/store.js";

export const WINDOW_LOCAL_KEK = "secret-window";

/** The window KMS of the process env, or null when it is not configured (openbao without address and token). */
export function windowKmsOf(env: Env, secrets: SecretStore | undefined): TransitKms | null {
  const c = byokConfigFromEnv(env);
  if (c.kms === "openbao") {
    if (!c.openbao) return null;
    const keyName = env.WIZARD_SECRET_WINDOW_TRANSIT_KEY?.trim() || "wizard-secret-window";
    return new OpenBaoTransit({ ...c.openbao, keyName });
  }
  return secrets ? new LocalTransit(secrets, WINDOW_LOCAL_KEK) : null;
}
