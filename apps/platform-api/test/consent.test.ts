// M0-26: compliance.consentText from compliance.consentTemplateId (security/compliance.yaml#system_package.consent.text).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { validateSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { CONSENT_TEMPLATES, renderConsentText, withConsentText } from "../src/agents/consent.js";
import { ROOT } from "./helpers.js";

const load = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, `specs/appspec/examples/${name}.json`), "utf8")) as AppSpec;

/** The spec as the builder leaves it: owner-only compliance fields are absent. */
function agentSpec(name: string, templateId?: string): AppSpec {
  const s = load(name);
  s.compliance = { policyPage: "/privacy", ...(templateId ? { consentTemplateId: templateId } : {}) };
  return s;
}

describe("consent text from the template", () => {
  test("default template lists the pii fields and names the owner as operator; the spec stays valid", () => {
    const s = withConsentText(agentSpec("forum"));
    const text = s.compliance?.consentText ?? "";
    expect(text).toMatch(/^Я соглашаюсь на обработку моих персональных данных \(/);
    expect(text).toContain("владелец системы");
    expect(text).toContain(s.app.name);
    const piiLabels = s.entities.flatMap((e) =>
      e.fields.filter((f) => f.pii && f.pii !== "none").map((f) => f.label.toLowerCase()),
    );
    for (const l of piiLabels) expect(text).toContain(l);
    expect(validateSpec(s).ok).toBe(true);
  });

  test("consentTemplateId selects the template; unknown id → default", () => {
    expect(renderConsentText(agentSpec("forum", "event_registration"))).toContain("мероприятии");
    expect(renderConsentText(agentSpec("bakery", "orders"))).toContain("заказа");
    expect(renderConsentText(agentSpec("bakery", "nope"))).toBe(renderConsentText(agentSpec("bakery")));
    expect(Object.keys(CONSENT_TEMPLATES)).toContain("default");
  });

  test("operator fields set by the owner are substituted; an owner's own consentText is kept as is", () => {
    const s = agentSpec("bakery");
    s.compliance = {
      ...s.compliance,
      operatorName: "ИП Сахарова А. В.",
      operatorContact: "sahar@example.ru",
    };
    expect(renderConsentText(s)).toContain("оператором ИП Сахарова А. В.");
    expect(renderConsentText(s)).toContain("(sahar@example.ru)");
    const own = load("forum");
    expect(withConsentText(own)).toBe(own);
  });
});
