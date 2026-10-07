// B2-41 (mvp-03 of the D76 measurement): a plan with «Заявки» and a landing always has the lead form on the landing —
// the model may replace it (a booking block instead) and the goal scenarios of leads then find no form. Deterministic,
// before the footer, as the matrix minimal landing has it.
import type { PlanSection, SystemPlan } from "@wizard/appspec";

const LEAD_FORM: PlanSection = { type: "lead_form", variant: "card", content: { title: "Оставьте заявку" } };

/** The plan with a lead form on its landing when it has «Заявки» and none is there; otherwise the same plan. */
export function withLeadForm(plan: SystemPlan): SystemPlan {
  if (!plan.landing || !plan.modules.some((m) => m.id === "leads")) return plan;
  if (plan.landing.sections.some((s) => s.type === "lead_form")) return plan;
  const sections = [...plan.landing.sections];
  const footer = sections.findIndex((s) => s.type === "footer");
  sections.splice(footer < 0 ? sections.length : footer, 0, LEAD_FORM);
  return { ...plan, landing: { ...plan.landing, sections } };
}
