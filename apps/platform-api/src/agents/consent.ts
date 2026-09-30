// Consent text from compliance.consentTemplateId (security/compliance.yaml#system_package.consent.text): template +
// substitutions from the spec. The platform fills it (author=system) only in the spec the draft runtime and G1 see;
// revisions keep owner-only fields owner-only (ops.yaml#set_compliance). Texts are DRAFT until the lawyer (E-LEGAL).
import type { AppSpec } from "@wizard/appspec";

interface ConsentVars {
  app: string;
  operator: string;
  data: string;
  contact: string;
}

type Template = (v: ConsentVars) => string;

const tail = (v: ConsentVars) =>
  `Согласие действует до достижения целей обработки; его можно отозвать, написав оператору${v.contact}.`;

/** Consent template registry; unknown or missing consentTemplateId → default. */
export const CONSENT_TEMPLATES: Readonly<Record<string, Template>> = {
  default: (v) =>
    `Я соглашаюсь на обработку моих персональных данных (${v.data}) оператором ${v.operator} для работы системы «${v.app}». ${tail(v)}`,
  event_registration: (v) =>
    `Я соглашаюсь на обработку моих персональных данных (${v.data}) оператором ${v.operator} для регистрации и участия в мероприятии «${v.app}». ${tail(v)}`,
  orders: (v) =>
    `Я соглашаюсь на обработку моих персональных данных (${v.data}) оператором ${v.operator} для оформления и выполнения заказа в «${v.app}». ${tail(v)}`,
};

function piiLabels(spec: AppSpec): string[] {
  const out = new Set<string>();
  for (const e of spec.entities)
    for (const f of e.fields) if (f.pii && f.pii !== "none") out.add(f.label.toLowerCase());
  return [...out];
}

/** Rendered consent text for a spec (template by compliance.consentTemplateId). */
export function renderConsentText(spec: AppSpec): string {
  const c = (spec.compliance ?? {}) as Record<string, unknown>;
  const id = typeof c.consentTemplateId === "string" ? c.consentTemplateId : "default";
  const template = CONSENT_TEMPLATES[id] ?? (CONSENT_TEMPLATES.default as Template);
  const labels = piiLabels(spec);
  const contact = typeof c.operatorContact === "string" ? ` (${c.operatorContact})` : "";
  return template({
    app: spec.app.name,
    operator: typeof c.operatorName === "string" ? c.operatorName : "владелец системы",
    data: labels.length > 0 ? labels.join(", ") : "контактные данные",
    contact,
  });
}

/** The spec the draft runtime and G1 run: consentText from the template unless the owner set their own. */
export function withConsentText(spec: AppSpec): AppSpec {
  const c = (spec.compliance ?? {}) as Record<string, unknown>;
  if (typeof c.consentText === "string" && c.consentText.trim() !== "") return spec;
  return { ...spec, compliance: { ...spec.compliance, consentText: renderConsentText(spec) } } as AppSpec;
}
