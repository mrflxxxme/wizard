// Consent text from compliance.consentTemplateId (security/compliance.yaml#system_package.consent.text): the lawyer's
// template from the runtime registry (apps/runtime templates, WIZARD_LEGAL_TEMPLATES_DIR) + substitutions from the spec.
// The platform fills it (author=system) only in the spec the draft runtime and G1 see; revisions keep owner-only fields
// owner-only (ops.yaml#set_compliance). Built-in templates are DRAFT and carry the draft mark until the lawyer (E-LEGAL).
import type { AppSpec } from "@wizard/appspec";
import {
  defaultLegalTemplates,
  type LegalTemplates,
  packageApplies,
  renderConsentText as renderTemplate,
} from "@wizard/runtime";

/** Rendered consent text (template by compliance.consentTemplateId, unknown → default); null without a template. */
export function renderConsentText(
  spec: AppSpec,
  templates: LegalTemplates = defaultLegalTemplates(),
): string | null {
  return renderTemplate(spec, templates);
}

/**
 * The spec the draft runtime and G1 run: consentText from the template unless the owner set their own; unchanged
 * when the 152-ФЗ package does not apply (the runtime asks no consent then).
 */
export function withConsentText(spec: AppSpec, templates: LegalTemplates = defaultLegalTemplates()): AppSpec {
  const c = spec.compliance ?? {};
  if (typeof c.consentText === "string" && c.consentText.trim() !== "") return spec;
  if (!packageApplies(spec)) return spec;
  const text = renderTemplate(spec, templates);
  if (text === null) return spec;
  return { ...spec, compliance: { ...spec.compliance, consentText: text } };
}
