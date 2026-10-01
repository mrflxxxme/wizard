// Consent metadata of a system (runtime.yaml#service_endpoints.role_spec, security/compliance.yaml#consent,
// #policy_page.versioning): policyVersion hashes the rendered policy; the consent text is the owner's own text or
// the lawyer's template (compliance.consentTemplateId) when the 152-ФЗ package applies.
import { createHash } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { effectivePolicyPage, packageApplies, renderConsentText, renderPolicy } from "./privacy/policy.js";
import { defaultLegalTemplates, type LegalTemplates } from "./privacy/templates.js";

export interface ComplianceInfo {
  consentText: string | null;
  /** compliance.policyPage, else /privacy when the package applies (privacy/policy.ts#effectivePolicyPage). */
  policyPage: string | null;
  /** Version of the rendered policy: sha256 of its text (hex, 16 chars). */
  policyVersion: string;
  /** sha256(consentText), hex; empty when the spec has no consent text (consent cannot be given). */
  consentTextHash: string;
}

export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

export function complianceInfo(
  spec: AppSpec,
  templates: LegalTemplates = defaultLegalTemplates(),
): ComplianceInfo {
  const own = spec.compliance?.consentText;
  const consentText =
    own !== undefined && own.trim() !== ""
      ? own
      : packageApplies(spec)
        ? renderConsentText(spec, templates)
        : null;
  const policy = renderPolicy(spec, templates);
  return {
    consentText,
    policyPage: effectivePolicyPage(spec),
    policyVersion: policy?.version ?? sha256Hex(JSON.stringify(spec.compliance ?? {})).slice(0, 16),
    consentTextHash: consentText === null ? "" : sha256Hex(consentText),
  };
}

/** True when `_consent` matches the current consent text and policy version. */
export function consentMatches(info: ComplianceInfo, consent: unknown): boolean {
  if (info.consentTextHash === "" || typeof consent !== "object" || consent === null) return false;
  const c = consent as Record<string, unknown>;
  return c.policyVersion === info.policyVersion && c.textHash === info.consentTextHash;
}
