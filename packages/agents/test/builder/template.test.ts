// D75 templates first: the pages generated from a site spec pass the G0 code checks (types, imports, security) with no
// model; the landing carries the lead form for the public role, each login role gets its cabinet.
import { type AppSpec, applyOps } from "@wizard/appspec";
import { checkCode, runGates } from "@wizard/gates";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  fallbackLanding,
  type LandingTexts,
  templateGaps,
  templatePages,
} from "../../src/builder/template.js";
import { type G1Harness, g1Harness } from "../qa-helpers.js";
import { leadSpec } from "./lead-fixture.js";

/** The lead spec as the ops phase of the template mode leaves it: no functions, no pages, guest creates leads. */
function siteSpec(): AppSpec {
  const base = leadSpec();
  const ops: Record<string, unknown>[] = [
    ...(base.pages ?? []).map((p) => ({ op: "remove_page", route: p.route })),
    ...(base.functions ?? []).map((f) => ({ op: "remove_function", name: f.name })),
    { op: "set_permission", role: "guest", entity: "lead", ops: ["create"] },
    { op: "set_permission", role: "admin", entity: "lead", ops: ["read", "update", "delete"] },
  ];
  const r = applyOps(base, ops, 0);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const texts: LandingTexts = {
  hero: { title: "Стоматология в Казани", subtitle: "Запишитесь на консультацию", cta: "Записаться" },
  features: { title: "Почему мы", items: [{ title: "Опыт", text: "Работаем с 2010 года" }] },
  steps: { title: "Как это работает", items: [{ title: "Заявка" }, { title: "Звонок" }] },
  faq: { title: "Вопросы", items: [{ question: "Сколько стоит?", answer: "Цена — после осмотра" }] },
  form: { title: "Оставьте заявку", submitLabel: "Отправить" },
};

function withPages(spec: AppSpec, t: LandingTexts) {
  const { ops, files } = templatePages(spec, t);
  const r = applyOps(spec, ops, 0);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { spec: r.spec, files: new Map(files), ops };
}

describe("site template (D75)", () => {
  test("a spec without functions fits; one with functions does not", () => {
    expect(templateGaps(siteSpec())).toEqual([]);
    expect(templateGaps(leadSpec())).toContain("в спеке есть серверные функции — их пишет харнесс");
  });

  test("pages: landing «/» with the lead form for guest and admin, the admin cabinet with status actions", () => {
    const { spec, files } = withPages(siteSpec(), texts);
    expect((spec.pages ?? []).map((p) => [p.route, p.file, p.roles])).toEqual([
      ["/cabinet", "ui/pages/Cabinet.tsx", ["admin"]],
      ["/", "ui/pages/Home.tsx", ["guest", "admin"]],
    ]);
    const home = files.get("ui/pages/Home.tsx") ?? "";
    expect(home).toContain('<LeadForm entity={"lead"}');
    expect(home).toContain('<DataTable entity={"service"}');
    expect(home).toContain('"Стоматология в Казани"');
    const cab = files.get("ui/pages/Cabinet.tsx") ?? "";
    expect(cab).toContain('patch: { status: "done" }');
    expect(cab).toContain('kind: "delete"');
  });

  test("the generated pages pass the G0 code checks", async () => {
    for (const t of [
      texts,
      fallbackLanding({ title: "Ремонт", summary: "Ремонт квартир", acceptance: [], roles: [] }),
    ]) {
      const { spec, files } = withPages(siteSpec(), t);
      const failed = await checkCode({ spec, files });
      expect(
        failed.map((c) => `${c.id} ${c.file ?? ""}:${c.line ?? ""} ${c.message_ru} ${c.evidence ?? ""}`),
      ).toEqual([]);
    }
  });
});

describe("site template on the real G1 (runtime, permissions, render)", () => {
  let h: G1Harness;
  beforeAll(async () => {
    h = await g1Harness();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("G1 at M1 has no blockers: permission probes, render of the landing and the cabinet", async () => {
    const { spec, files } = withPages(siteSpec(), texts);
    const r = await runGates("G1", h.ctx(spec, files, { milestone: "M1" }));
    const blockers = r.checks.filter(
      (c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"),
    );
    expect(blockers.map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`)).toEqual([]);
    expect(r.checks.some((c) => c.id === "G1-RENDER-01" && c.status === "pass")).toBe(true);
  }, 120_000);
});
