// M0-26 / M2-05: compliance.consentText from compliance.consentTemplateId through the runtime's legal template registry
// (security/compliance.yaml#system_package.consent.text): the draft runtime and G1 see the marked draft templates.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { validateSpec } from "@wizard/appspec";
import { complianceInfo, DRAFT_MARK, loadLegalTemplates } from "@wizard/runtime";
import { describe, expect, test } from "vitest";
import { renderConsentText, withConsentText } from "../src/agents/consent.js";
import { ROOT } from "./helpers.js";

const load = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, `specs/appspec/examples/${name}.json`), "utf8")) as AppSpec;

/** The spec as the builder leaves it: owner-only compliance fields are absent. */
function agentSpec(name: string, templateId?: string): AppSpec {
  const s = load(name);
  s.compliance = { policyPage: "/privacy", ...(templateId ? { consentTemplateId: templateId } : {}) };
  return s;
}

describe("consent text from the runtime template registry", () => {
  test("default template: draft mark, pii labels; the spec stays valid and matches the runtime's own rendering", () => {
    const spec = agentSpec("forum");
    const s = withConsentText(spec);
    const text = s.compliance?.consentText ?? "";
    expect(text.startsWith(DRAFT_MARK)).toBe(true);
    expect(text).toContain(s.app.name);
    const piiLabels = s.entities.flatMap((e) =>
      e.fields.filter((f) => f.pii && f.pii !== "none").map((f) => f.label.toLowerCase()),
    );
    for (const l of piiLabels) expect(text).toContain(l);
    expect(validateSpec(s).ok).toBe(true);
    // The runtime renders the same text for the spec without it: consent hashes agree between draft and G1.
    expect(complianceInfo(s).consentTextHash).toBe(complianceInfo(spec).consentTextHash);
  });

  test("consentTemplateId selects the template; unknown id → default", () => {
    const def = renderConsentText(agentSpec("bakery"));
    const orders = renderConsentText(agentSpec("bakery", "orders"));
    const event = renderConsentText(agentSpec("forum", "event_registration"));
    expect(orders).not.toBe(def);
    expect(event).not.toBe(renderConsentText(agentSpec("forum")));
    for (const t of [def, orders, event]) expect(t).toContain(DRAFT_MARK);
    expect(renderConsentText(agentSpec("bakery", "nope"))).toBe(def);
  });

  test("operator fields set by the owner are substituted; an owner's own consentText is kept as is", () => {
    const s = agentSpec("bakery");
    s.compliance = {
      ...s.compliance,
      operatorName: "ИП Сахарова А. В.",
      operatorContact: "sahar@example.ru",
    };
    expect(renderConsentText(s)).toContain("ИП Сахарова А. В.");
    expect(renderConsentText(s)).toContain("sahar@example.ru");
    const own = load("forum");
    expect(withConsentText(own)).toBe(own);
  });

  test("a lawyer's template from WIZARD_LEGAL_TEMPLATES_DIR replaces the draft", () => {
    const dir = mkdtempSync(join(tmpdir(), "wz-legal-"));
    try {
      writeFileSync(
        join(dir, "consent.md"),
        "---\nid: default\nkind: consent\nversion: 1.0.0\nstatus: approved\n---\nСогласие для «{{appName}}», оператор {{operatorName}}.\n",
      );
      const text = withConsentText(agentSpec("bakery"), loadLegalTemplates(dir)).compliance?.consentText;
      expect(text).toMatch(/^Согласие для «.+», оператор /);
      expect(text).not.toContain(DRAFT_MARK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no package (no pii, no login) → no consent text injected", () => {
    const s = agentSpec("bakery");
    const bare = {
      ...s,
      roles: s.roles.map((r) => ({ ...r, access: "public" as const })),
      entities: s.entities.map((e) => ({
        ...e,
        fields: e.fields.map((f) => ({ ...f, pii: "none" as const })),
      })),
    } as AppSpec;
    expect(withConsentText(bare)).toBe(bare);
  });
});
