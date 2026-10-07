// B2-49 (D76 control measurement, mvp-07 «CRM агентства недвижимости»: landing, client_card, deals, staff): a landing
// with nothing for the public to do — no lead form or booking section and no public page of the plan — had the name, an
// empty header and a hero without a button. Its header button, hero button and call to action are now the team's
// «Войти» (the cabinet's sign-in); a landing with a call-to-action target or public pages keeps its buttons.
import type { SystemPlan } from "@wizard/appspec";
import { describe, expect, it } from "vitest";
import { compilePlan, SIGN_IN_LABEL } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";
import { crmLandingPlan } from "./fixtures-b249.js";

const registry = testRegistry();

function home(p: SystemPlan) {
  const r = compilePlan(p, registry, { appName: "Квартал" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return { r, home: r.files["ui/pages/Home.tsx"] ?? "" };
}

const SIGN_IN = `{"label":"${SIGN_IN_LABEL}","href":"/login?next=%2Fcabinet"}`;

describe("landing without public actions (B2-49)", () => {
  it("CRM landing: «Войти» in the header, the hero and the call to action; no empty menu items", () => {
    const { r, home: h } = home(crmLandingPlan());
    expect(r.spec.pages?.find((p) => p.route === "/")?.file).toBe("ui/pages/Home.tsx");
    expect(r.spec.pages?.some((p) => p.route === "/cabinet")).toBe(true);
    expect(h).toMatch(new RegExp(`<Header [^\\n]*cta=\\{${reEscape(SIGN_IN)}\\}`));
    expect(h).toMatch(new RegExp(`<Hero [^\\n]*primary=\\{${reEscape(SIGN_IN)}\\}`));
    expect(h).toMatch(new RegExp(`<Cta [^\\n]*action=\\{${reEscape(SIGN_IN)}\\}`));
    expect(h).not.toContain("Оставить заявку");
    expect(h).not.toContain('"href":"/"}');
    const links = /<Header [^\n]*links=\{(\[[^\n]*?\])\}/.exec(h)?.[1];
    const menu = JSON.parse(links ?? "[]") as { label: string; href: string }[];
    for (const l of menu) {
      expect(l.label.trim()).not.toBe("");
      expect(l.href).toMatch(/^#[a-z_0-9]+$/);
      expect(l.label).not.toBe(SIGN_IN_LABEL);
    }
    expect(menu.map((l) => l.label)).toEqual(["Что внутри", "Как мы работаем", "Готовы начать?"]);
  });

  it("CRM landing without the menu: no links attribute (no empty nav)", () => {
    const p = crmLandingPlan();
    p.modules[0] = { id: "landing", params: { anchor_nav: false } };
    const { home: h } = home(p);
    expect(h).not.toContain("links=");
    expect(h).toContain(`cta={${SIGN_IN}}`);
  });

  it("a landing with a lead form keeps its buttons", () => {
    const { home: h } = home(landingLeadsPlan());
    expect(h).toContain('cta={{"label":"Записаться","href":"#lead"}}');
    expect(h).toContain('primary={{"label":"Оставить заявку","href":"#lead"}}');
    expect(h).toContain('action={{"label":"Спросить","href":"#lead"}}');
    expect(h).not.toContain(`"label":"${SIGN_IN_LABEL}"`);
  });

  it("CRM landing with a public page of the plan (booking): no «Войти», behaviour as before", () => {
    const { home: h } = home(
      crmLandingPlan([
        { id: "catalog", params: { with_duration: true } },
        { id: "booking" },
        { id: "notify" },
      ]),
    );
    expect(h).not.toContain(`"label":"${SIGN_IN_LABEL}"`);
    expect(h).not.toMatch(/<Hero [^\n]*primary=/);
    expect(h).not.toMatch(/<Header [^\n]*cta=/);
  });

  it("is deterministic", () => {
    expect(home(crmLandingPlan()).home).toBe(home(crmLandingPlan()).home);
  });
});

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
