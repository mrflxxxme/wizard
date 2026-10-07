// B2-41 (mvp-03 of the D76 measurement): «Заявки» with a landing always get the lead form, before the footer; a plan
// that has it, or has no «Заявки» or no landing, stays the same object.
import type { SystemPlan } from "@wizard/appspec";
import { describe, expect, it } from "vitest";
import { compilePlan, withLeadForm } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";

const withoutForm = (p: SystemPlan): SystemPlan =>
  p.landing ? { ...p, landing: { sections: p.landing.sections.filter((s) => s.type !== "lead_form") } } : p;

describe("withLeadForm", () => {
  it("a landing of «Заявки» without the form gets it before the footer, and the plan compiles", () => {
    const plan = withoutForm(landingLeadsPlan());
    const fixed = withLeadForm(plan);
    const types = fixed.landing?.sections.map((s) => s.type) ?? [];
    expect(types.filter((t) => t === "lead_form")).toHaveLength(1);
    expect(types.indexOf("lead_form")).toBe(types.indexOf("footer") - 1);
    expect(compilePlan(fixed, testRegistry(), { appName: "Улыбка" }).ok).toBe(true);
  });

  it("a plan with the form, without «Заявки» or without a landing is returned as is", () => {
    const full = landingLeadsPlan();
    expect(withLeadForm(full)).toBe(full);
    const noLeads = { ...withoutForm(full), modules: full.modules.filter((m) => m.id !== "leads") };
    expect(withLeadForm(noLeads)).toBe(noLeads);
    const { landing: _l, ...noLanding } = full;
    expect(withLeadForm(noLanding as SystemPlan)).toBe(noLanding);
  });
});
