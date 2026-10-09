// V3-13 acceptance (node part): the visual critic on recorded answers (v3-critic-fixtures.ts: suite demo in a temporary
// dir, usage priced by models.yaml; no network, no money) over the clinic's skeleton site and a fake browser whose
// deterministic problems follow rules. Algorithms first: a section the checks flag gets another variant and a token
// step without a model; then ≤ 3 critic_visual cycles (images → T0) whose findings carry closed edits (applyEdit), each
// linted, built (G0) and re-checked, a regression rolled back; stop on pass, when the score stops growing, on budget.
import type { CriticInspectInput, CriticReport } from "@wizard/agents/builder";
import { LlmError } from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import {
  applyEdit,
  type CriticState,
  createCriticHook,
  critiquePasses,
  critiqueSchema,
  critiqueScore,
  critiqueTool,
  type EditEnv,
  parseWhere,
  readSite,
  runCritic,
} from "../src/builder/index.js";
import { siteFacts } from "../src/builder/v3/compose/index.js";
import {
  criticContext,
  critique,
  critiqueLines,
  fakeInspector,
  firstPrompt,
  fixtureRoute,
  registry,
  whenCss,
  whenPattern,
} from "./v3-critic-fixtures.js";

const ctx = await criticContext();
const env: EditEnv = { library: PATTERNS, numbers: siteFacts(ctx).numbers };
const state: CriticState = { site: ctx.site, design: ctx.design };
const home = () => ctx.site.pages.find((p) => p.route === "/");
const prompt = firstPrompt(ctx);
const noModel: typeof ctx.route = async () => {
  throw new Error("no model in this test");
};
const siteOf = (r: CriticReport) => readSite(new Map([["ui/site.json", r.files.get("ui/site.json") ?? ""]]));

const F = {
  swap: {
    sign: "L06 повтор раскладок: первый экран и услуги — две колонки подряд",
    where: "/@1440#services",
    severity: "P1",
    evidence: "изображение 4, 940–1500 px",
    replace: "прайс-лист услуг",
    edit: { op: "swap_variant", route: "/", section: "services", pattern: "services-price-list" },
  },
  reorder: {
    sign: "форма заявки ниже услуг уводит действие вниз",
    where: "/@390#form",
    severity: "P2",
    evidence: "изображение 4, форма на 1500 px",
    replace: "форма сразу после первого экрана",
    edit: { op: "reorder", route: "/", order: ["hero", "form", "services"] },
  },
  number: {
    sign: "K03 заголовок без факта",
    where: "/@390#hero",
    severity: "P2",
    evidence: "изображение 1, заголовок",
    replace: "заголовок с числом пациентов",
    edit: {
      op: "set_text",
      route: "/",
      section: "hero",
      path: "title",
      text: "Лечим зубы без боли — 500 пациентов в год",
    },
  },
  heroSwap: {
    sign: "L13 первый экран перегружен на телефоне",
    where: "/@390#hero",
    severity: "P2",
    evidence: "изображение 1",
    replace: "первый экран во всю ширину с фото",
    edit: { op: "swap_variant", route: "/", section: "hero", pattern: "hero-full-bleed" },
  },
  lead: {
    sign: "подзаголовок не говорит, что делать",
    where: "/@390#hero",
    severity: "P3",
    evidence: "изображение 1, под заголовком",
    replace: "конкретнее про звонок",
    edit: {
      op: "set_text",
      route: "/",
      section: "hero",
      path: "lead",
      text: "Оставьте заявку на сайте — администратор перезвонит за 15 минут",
    },
  },
  free: {
    sign: "фирменной детали не хватает",
    where: "/@1440#hero",
    severity: "P2",
    evidence: "изображение 3",
    replace: "фирменная секция с путём пациента",
    edit: { op: "rewrite_code", source: "<div />" },
  },
  nowhere: {
    sign: "вообще всё серое",
    where: "главная, первый экран",
    severity: "P1",
    evidence: "везде",
    replace: "поярче",
    edit: null,
  },
} as const;

describe("V3-13 rubric", () => {
  test("score 0–100 from the axes minus findings; pass — no P0/P1, axes ≥ 3, production", () => {
    const c = critiqueSchema.parse(critique(3, [F.reorder], "production"));
    expect(critiqueScore(c)).toBe(73);
    expect(critiquePasses(c)).toBe(true);
    expect(critiquePasses(critiqueSchema.parse(critique(3, [F.swap], "production")))).toBe(false);
    expect(critiquePasses(critiqueSchema.parse(critique({ specificity: 2 }, [], "production")))).toBe(false);
    expect(critiquePasses(critiqueSchema.parse(critique(4, [], "draft")))).toBe(false);
    expect(parseWhere("/services@768#catalog")).toEqual({
      route: "/services",
      width: 768,
      section: "catalog",
    });
    expect(parseWhere("/@1280#hero")).toBeNull();
  });

  test("submit_critique: an edit outside the closed set becomes a note, a finding without «where» is dropped", () => {
    const r = critiqueTool.parse(critique(2, [F.swap, F.free, F.nowhere]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.findings.map((f) => f.sign)).toEqual([F.swap.sign, F.free.sign]);
    expect(r.value.findings[1]?.edit).toBeNull();
    // No replacement or no observable sign — not a finding (catalog C «отбрасываем»).
    expect(critiqueTool.parse(critique(2, [{ ...F.swap, replace: "" }])).ok).toBe(false);
  });
});

describe("V3-13 edit operations (closed set, applied by code)", () => {
  test("swap_variant: same type and binding, the slots accept the content; header and footer site-wide", () => {
    const ok = applyEdit(
      state,
      { op: "swap_variant", route: "/", section: "services", pattern: "services-price-list" },
      env,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok)
      expect(ok.state.site.pages[0]?.sections.find((s) => s.id === "services")?.pattern).toBe(
        "services-price-list",
      );
    const other = applyEdit(
      state,
      { op: "swap_variant", route: "/", section: "services", pattern: "hero-centered" },
      env,
    );
    expect(other.ok).toBe(false);
    const form = applyEdit(
      state,
      { op: "swap_variant", route: "/", section: "form", pattern: "form-booking-grid" },
      env,
    );
    expect(form.ok ? "" : form.reason_ru).toContain("привязки к данным");
    const header = applyEdit(
      state,
      { op: "swap_variant", route: "/", section: "header", pattern: "header-classic" },
      env,
    );
    expect(header.ok).toBe(true);
    if (header.ok) {
      expect(header.touched).toBe("site");
      for (const p of header.state.site.pages)
        expect(p.sections.find((s) => s.type === "header")?.pattern).toBe("header-classic");
    }
  });

  test("reorder: every body section once, the first screen first", () => {
    expect(applyEdit(state, { op: "reorder", route: "/", order: ["hero", "form", "services"] }, env).ok).toBe(
      true,
    );
    const heroLast = applyEdit(
      state,
      { op: "reorder", route: "/", order: ["form", "services", "hero"] },
      env,
    );
    expect(heroLast.ok ? "" : heroLast.reason_ru).toContain("первый экран");
    expect(applyEdit(state, { op: "reorder", route: "/", order: ["hero", "form"] }, env).ok).toBe(false);
  });

  test("set_text: copy rules, no number the brief lacks (D49), links and bindings are not texts", () => {
    const ok = applyEdit(state, F.lead.edit, env);
    expect(ok.ok).toBe(true);
    const num = applyEdit(state, F.number.edit, env);
    expect(num.ok ? "" : num.reason_ru).toContain("untraced-number");
    const stop = applyEdit(
      state,
      {
        op: "set_text",
        route: "/",
        section: "hero",
        path: "title",
        text: "Уникальный подход к лечению зубов",
      },
      env,
    );
    expect(stop.ok).toBe(false);
    const href = applyEdit(
      state,
      { op: "set_text", route: "/", section: "hero", path: "action.href", text: "#x" },
      env,
    );
    expect(href.ok).toBe(false);
    const entity = applyEdit(
      state,
      { op: "set_text", route: "/", section: "form", path: "entity", text: "x" },
      env,
    );
    expect(entity.ok).toBe(false);
  });

  test("token: within the archetype and designLint", () => {
    const airy = applyEdit(state, { op: "token", token: "density", value: "airy" }, env);
    expect(airy.ok).toBe(true);
    if (airy.ok) expect(airy.state.design.grid.rhythm.section.desktop).toBe(128);
    // calm_medical has soft and round corners only.
    expect(applyEdit(state, { op: "token", token: "radius", value: "sharp" }, env).ok).toBe(false);
    expect(applyEdit(state, { op: "token", token: "radius", value: "soft" }, env).ok).toBe(true);
    const muted = applyEdit(state, { op: "token", token: "muted_contrast", value: "light" }, env);
    expect(muted.ok).toBe(true);
    if (muted.ok) expect(muted.state.design.palette.light.muted).not.toBe(ctx.design.palette.light.muted);
    expect(applyEdit(state, { op: "token", token: "density", value: "dense" }, env).ok).toBe(false);
  });

  test("drop_section: not the first screen, not a section bound to data", () => {
    const page = home();
    expect(page?.sections.map((s) => s.id)).toEqual(["header", "hero", "services", "form", "footer"]);
    expect(applyEdit(state, { op: "drop_section", route: "/", section: "hero" }, env).ok).toBe(false);
    const form = applyEdit(state, { op: "drop_section", route: "/", section: "form" }, env);
    expect(form.ok ? "" : form.reason_ru).toContain("данными");
    expect(applyEdit(state, { op: "drop_section", route: "/", section: "services" }, env).ok).toBe(true);
  });
});

describe("V3-13 critic", () => {
  test("deterministic checks first: a variant swap fixes the overflow and a token step the contrast, no model", async () => {
    const calls: CriticInspectInput[] = [];
    const inspect = fakeInspector(
      [whenPattern("services-editorial", "L11", [390]), whenCss(ctx.design.palette.light.muted, "C08")],
      calls,
    );
    const r = await runCritic({ ...ctx, route: noModel }, { inspect, verify: null, maxCycles: 0 });
    expect(r.status).toBe("done");
    expect(r.cycles).toEqual([]);
    expect(r.fixes).toHaveLength(2);
    expect(r.fixes[0]).toMatch(/services-editorial → services-(price-list|tabs) \(L11\)/);
    expect(r.fixes[1]).toContain("(C08)");
    expect(r.before.penalty).toBeGreaterThan(0);
    expect(r.after.penalty).toBe(0);
    expect(r.left).toEqual([]);
    // The first inspection: every public page at 390/768/1440 light and 390 dark, the screenshots of a cycle.
    expect(calls[0]?.routes).toEqual(["/", "/services", "/photos"]);
    expect(calls[0]?.viewports.map((v) => `${v.width}${v.scheme[0]}`)).toEqual([
      "390l",
      "768l",
      "1440l",
      "390d",
    ]);
    expect(calls[0]?.shots.map((s) => `${s.route}@${s.width}:${s.kind}`)).toEqual([
      "/@390:screen",
      "/@768:screen",
      "/@1440:screen",
      "/@1440:page",
      "/services@390:screen",
    ]);
    expect(calls[0]?.fonts).toEqual([ctx.design.fonts.display.family, ctx.design.fonts.text.family]);
    // The files: the page with the new variant, the design CSS with the stepped colour, the site model.
    const site = siteOf(r);
    expect(site?.pages[0]?.sections.find((s) => s.id === "services")?.pattern).not.toBe("services-editorial");
    expect(r.files.get("ui/design.css")).not.toContain(ctx.design.palette.light.muted);
    expect(r.files.get("ui/patterns/services-editorial.tsx")).toBeNull();
    expect(r.notes[0]).toContain("Проверил сайт в браузере");
    expect(r.notes[1]).toMatch(/^Поправил 2 места/);
  });

  test("cycles on recorded answers: T0 vision model, closed edits applied and re-checked, pass on cycle 2, ≤ 40 ₽", async () => {
    const fx = fixtureRoute(
      critiqueLines(prompt, [
        critique(2, [F.swap, F.reorder, F.number, F.free, F.nowhere]),
        critique(3, [{ ...F.lead, edit: null }], "production"),
      ]),
    );
    const calls: CriticInspectInput[] = [];
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([], calls), verify: null, registry },
    );
    expect(r.stop).toBe("pass");
    expect(r.cycles.map((c) => [c.n, c.score, c.pass])).toEqual([
      [1, 38, false],
      [2, 75, true],
    ]);
    // Screenshots are images: the router keeps critic_visual on T0 (data-boundary critic_visual: T1 only after D62).
    expect(r.cycles.map((c) => `${c.tier}:${c.model}`)).toEqual(["T0:kimi-k2.6", "T0:kimi-k2.6"]);
    expect(fx.calls.map((c) => c.callType)).toEqual(["critic_visual", "critic_visual"]);
    const user = fx.calls[0]?.messages.find((m) => m.role === "user");
    expect(user && "attachments" in user ? user.attachments?.length : 0).toBe(5);
    expect(user?.content).toContain("варианты: services-price-list, services-tabs");
    expect(user?.content).toContain("Код ничего не нашёл");
    // Cycle 1: the swap and the order applied; the number not in the brief refused (D49), the free code is a note.
    expect(r.cycles[0]?.applied).toEqual([
      "/#services: вариант services-editorial → services-price-list",
      "/: порядок секций hero → form → services",
    ]);
    expect(r.cycles[0]?.rejected.map((x) => x.reason_ru)).toEqual([
      expect.stringContaining("untraced-number"),
    ]);
    // Cycle 2 sees what was done and refused.
    const second = fx.calls[1]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(second).toContain(
      "Цикл 1: применено — /#services: вариант services-editorial → services-price-list",
    );
    expect(second).toContain("отклонено — /#hero.title");
    // The batch was checked in the browser before the next screenshots; nothing rolled back.
    expect(calls.length).toBe(2);
    expect(r.rolledBack).toEqual([]);
    const site = siteOf(r);
    expect(site?.pages[0]?.sections.map((s) => `${s.id}:${s.pattern}`)).toEqual([
      "header:header-floating",
      "hero:hero-split",
      "form:form-inline",
      "services:services-price-list",
      "footer:footer-columns",
    ]);
    expect(r.files.get("ui/pages/site/Home.tsx")).toContain(
      'import ServicesPriceList from "../../patterns/services-price-list";',
    );
    // Money: the T0 price of the recorded usage, each cycle well under a third of the cap.
    expect(r.spentRub).toBeGreaterThan(0);
    expect(r.spentRub).toBeLessThanOrEqual(40);
    for (const c of r.cycles) expect(c.costRub).toBeLessThan(40 / 3);
    expect(r.spentRub).toBeCloseTo(
      r.cycles.reduce((s, c) => s + c.costRub, 0),
      1,
    );
    expect(r.notes[0]).toMatch(/2 круга, оценка 38 → 75 из 100/);
  });

  test("a regression in the browser checks rolls back the edit that caused it, the rest stays", async () => {
    const fx = fixtureRoute(
      critiqueLines(prompt, [critique(2, [F.heroSwap, F.reorder]), critique(3, [], "production")]),
    );
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([whenPattern("hero-full-bleed", "C08", [390])]), verify: null, registry },
    );
    expect(r.cycles[0]?.applied).toEqual(["/: порядок секций hero → form → services"]);
    expect(r.cycles[0]?.rejected).toEqual([
      {
        edit: "/#hero → hero-full-bleed",
        reason_ru: expect.stringContaining("откат: проверки в браузере: C08 /#hero"),
      },
    ]);
    expect(r.rolledBack).toHaveLength(1);
    expect(siteOf(r)?.pages[0]?.sections.find((s) => s.id === "hero")?.pattern).toBe("hero-split");
    expect(r.after.penalty).toBe(0);
  });

  test("a batch that fails G0 is tried edit by edit: the one that breaks the build is rolled back", async () => {
    const fx = fixtureRoute(
      critiqueLines(prompt, [
        critique(2, [
          F.swap,
          {
            ...F.reorder,
            edit: { op: "swap_variant", route: "/", section: "form", pattern: "form-stepper" },
          },
        ]),
        critique(3, [], "production"),
      ]),
    );
    const verify = async (_spec: unknown, files: ReadonlyMap<string, string>) =>
      files.get("ui/site.json")?.includes("form-stepper")
        ? { ok: false, problems: ["G0-TS-01: ошибка типов в ui/patterns/form-stepper.tsx"] }
        : { ok: true, problems: [] };
    const r = await runCritic({ ...ctx, route: fx.route }, { inspect: fakeInspector([]), verify, registry });
    expect(r.cycles[0]?.applied).toEqual(["/#services: вариант services-editorial → services-price-list"]);
    expect(r.cycles[0]?.rejected[0]?.reason_ru).toContain("откат: сборка: G0-TS-01");
  });

  test("the score falls after a batch: the batch is rolled back and the critic stops", async () => {
    const fx = fixtureRoute(critiqueLines(prompt, [critique(3, [F.swap]), critique(2, [F.reorder])]));
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([]), verify: null, registry },
    );
    expect(r.stop).toBe("no_gain");
    expect(r.cycles.map((c) => c.score)).toEqual([69, 48]);
    expect(r.rolledBack).toEqual(["/#services: вариант services-editorial → services-price-list"]);
    expect(r.files.size).toBe(0);
  });

  test("at most 3 cycles, each paid by its own call", async () => {
    const fx = fixtureRoute(
      critiqueLines(prompt, [
        critique(1, [F.swap]),
        critique(2, [F.reorder]),
        critique(3, [{ ...F.lead, severity: "P1" }]),
        critique(4, [], "production"),
      ]),
    );
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([]), verify: null, registry },
    );
    expect(r.stop).toBe("cycles");
    expect(fx.calls).toHaveLength(3);
    expect(r.cycles.map((c) => c.applied.length)).toEqual([1, 1, 1]);
    expect(r.spentRub).toBeLessThanOrEqual(40);
    // A fourth cycle is not asked for even when the stage allows more.
    const more = await runCritic(
      { ...ctx, route: fixtureRoute(critiqueLines(prompt, Array(5).fill(critique(1, [F.swap])))).route },
      { inspect: fakeInspector([]), verify: null, registry, maxCycles: 5 },
    );
    expect(more.cycles.length).toBeLessThanOrEqual(3);
  });

  test("budget: a call whose upper bound does not fit is not made; the checks still run", async () => {
    const fx = fixtureRoute(critiqueLines(prompt, [critique(2, [F.swap])]));
    const r = await runCritic(
      { ...ctx, budgetRub: 0.5, route: fx.route },
      { inspect: fakeInspector([whenPattern("services-editorial", "L11", [390])]), verify: null, registry },
    );
    expect(r.stop).toBe("budget");
    expect(fx.calls).toHaveLength(0);
    expect(r.fixes).toHaveLength(1);
  });

  test("the model unavailable or the fixture missing: the critic keeps what code did, never fails the build", async () => {
    const down: typeof ctx.route = async () => {
      throw new LlmError("LLM_UNAVAILABLE", "Модели недоступны");
    };
    const r = await runCritic(
      { ...ctx, route: down },
      { inspect: fakeInspector([]), verify: null, registry },
    );
    expect(r.status).toBe("done");
    expect(r.stop).toBe("model");
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runCritic(
        { ...ctx, route: down, signal: aborted.signal },
        { inspect: fakeInspector([]), verify: null, registry },
      ),
    ).rejects.toThrow();
  });

  test("the hook: a files layer and Russian notes for the harness; skipped without a public site", async () => {
    const fx = fixtureRoute(critiqueLines(prompt, [critique(2, [F.swap]), critique(3, [], "production")]));
    const hook = createCriticHook({ inspect: fakeInspector([]), verify: null, registry });
    const out = await hook({ ...ctx, route: fx.route });
    expect(out.status).toBe("done");
    expect(out.files?.get("ui/site.json")).toContain("services-price-list");
    expect(out.notes?.[0]).toMatch(/^Посмотрел сайт на телефоне, планшете и компьютере/);
    expect(out.spentRub).toBe(0);
    expect(out.blockers).toBeUndefined();
    expect(out.note).toMatch(/циклов 2, оценка 44→75/);
    const none = await hook({ ...ctx, files: new Map(), route: noModel });
    expect(none.status).toBe("skipped");
    const broken = await createCriticHook({
      inspect: async () => ({ ok: false, error: "сборка упала", problems: [], shots: [] }),
      verify: null,
    })({ ...ctx, route: noModel });
    expect(broken).toEqual({ status: "skipped", note: expect.stringContaining("сборка упала") });
  });
});
