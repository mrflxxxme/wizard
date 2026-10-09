// BYOK feature flag and KMS choice (V3-33). Public enablement waits for the lawyer (V3-35, docs/reviews/grill-8.md
// № 14б): by default the feature is OFF for everyone; WIZARD_BYOK_ORGS opens it to listed orgs (the founder's tests);
// WIZARD_BYOK=on opens it to all orgs and MUST NOT be set before V3-35 is done (security/data-boundary.yaml#byok.flag).
import type { SecretStore } from "../secrets/store.js";
import { LocalTransit, OpenBaoTransit, type TransitKms } from "./kms.js";

export type Env = Record<string, string | undefined>;

export interface ByokConfig {
  /** WIZARD_BYOK=on — every org (after V3-35 only); otherwise only `orgs`. */
  public: boolean;
  /** WIZARD_BYOK_ORGS: comma-separated org ids allowed while the feature is not public. */
  orgs: ReadonlySet<string>;
  /** local (SecretStore KEK) | openbao (Transit); production defaults to openbao. */
  kms: "local" | "openbao";
  openbao: { addr: string; token: string; mount: string; keyName: string } | null;
  /** WIZARD_BYOK_ALLOW_PRIVATE_NETWORK=1: gateways on loopback/private hosts and plain http (dev stands; never production). */
  allowPrivateNetwork: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function byokConfigFromEnv(env: Env = process.env): ByokConfig {
  const production = env.NODE_ENV === "production";
  const orgs = new Set(
    (env.WIZARD_BYOK_ORGS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => UUID.test(s)),
  );
  const kms =
    env.WIZARD_BYOK_KMS === "local" || env.WIZARD_BYOK_KMS === "openbao"
      ? env.WIZARD_BYOK_KMS
      : production
        ? "openbao"
        : "local";
  const addr = env.WIZARD_OPENBAO_ADDR?.trim();
  const token = env.WIZARD_OPENBAO_TOKEN?.trim();
  return {
    public: env.WIZARD_BYOK === "on",
    orgs,
    kms,
    openbao:
      addr && token
        ? {
            addr,
            token,
            mount: env.WIZARD_OPENBAO_TRANSIT_MOUNT?.trim() || "transit",
            keyName: env.WIZARD_BYOK_TRANSIT_KEY?.trim() || "wizard-byok",
          }
        : null,
    allowPrivateNetwork: !production && env.WIZARD_BYOK_ALLOW_PRIVATE_NETWORK === "1",
  };
}

/** true → nobody can use BYOK in this process (no router hook, no work per call). */
export function byokOff(c: ByokConfig): boolean {
  return !c.public && c.orgs.size === 0;
}

/** The KMS of the config, or null when it is not configured (openbao without address and token, no secret store). */
export function kmsOf(c: ByokConfig, secrets: SecretStore | undefined): TransitKms | null {
  if (c.kms === "openbao") return c.openbao ? new OpenBaoTransit(c.openbao) : null;
  return secrets ? new LocalTransit(secrets) : null;
}
