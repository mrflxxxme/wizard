// Consent metadata of a system (runtime.yaml#service_endpoints.role_spec, security/compliance.yaml#consent).
import { createHash } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";

export interface ComplianceInfo {
  consentText: string | null;
  policyPage: string | null;
  /** Version of the rendered policy: sha256 of the compliance block (hex, 16 chars). */
  policyVersion: string;
  /** sha256(consentText), hex; empty when the spec has no consent text (consent cannot be given). */
  consentTextHash: string;
}

export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

export function complianceInfo(spec: AppSpec): ComplianceInfo {
  const c = spec.compliance ?? {};
  const consentText = c.consentText ?? null;
  const rendered = JSON.stringify([
    c.consentText ?? "",
    c.policyPage ?? "",
    c.operatorName ?? "",
    c.operatorContact ?? "",
    c.operatorAddress ?? "",
    c.operatorInn ?? "",
  ]);
  return {
    consentText,
    policyPage: c.policyPage ?? null,
    policyVersion: sha256Hex(rendered).slice(0, 16),
    consentTextHash: consentText === null ? "" : sha256Hex(consentText),
  };
}

/** True when `_consent` matches the current consent text and policy version. */
export function consentMatches(info: ComplianceInfo, consent: unknown): boolean {
  if (info.consentTextHash === "" || typeof consent !== "object" || consent === null) return false;
  const c = consent as Record<string, unknown>;
  return c.policyVersion === info.policyVersion && c.textHash === info.consentTextHash;
}
