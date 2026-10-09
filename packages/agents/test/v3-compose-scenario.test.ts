// V3-12 acceptance 1: a scenario of the brief brought to its page by the models (WIZARD_LLM_MODE=fixture: recorded
// answers through the fixture router or a scripted route, no live calls) — page_compose chooses library variants and
// writes the texts as tool-shaped JSON checked by the slot schemas and the anti-slop linter (repairs go back to the
// model); signature_section writes ≤ 2 signature sections in free code, checked by the linter and G0 (imports,
// forbidden API, types, build); a signature section that fails gets a library pattern in its place. Every call fits
// the step's budget; owner and staff scenarios do not touch the public pages.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BriefScenario } from "@wizard/appspec";
import { runG0 } from "@wizard/gates";
import {
  createRegistry,
  createRouter,
  type FixtureLine,
  type RouteInput,
  type RouteOutput,
} from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import {
  COMPOSE_CALL_TYPES,
  createPageComposer,
  lintErrors,
  lintSitePage,
  type PageComposeAnswer,
  pageComposeRequest,
  readSite,
  type SiteModel,
  signatureOffer,
  signatureRequest,
  siteFacts,
  withSitePages,
} from "../src/builder/v3/compose/index.js";
import type { V3BuildContext, V3ComposeResult } from "../src/builder/v3/contract.js";
import { fixtureLine } from "./build-v2-fixtures.js";
import { BRIEF, composeContext, SIGNATURE_OK } from "./v3-compose-fixtures.js";

const llm = createRegistry({ buildDefaultTier: "T1" });
const LEAD = BRIEF.scenarios[0] as BriefScenario;
const PRICES = BRIEF.scenarios[1] as BriefScenario;
const OWNER = BRIEF.scenarios[2] as BriefScenario;

function apply(files: ReadonlyMap<string, string>, out: V3ComposeResult): Map<string, string> {
  const next = new Map(files);
  for (const [p, v] of out.files) {
    if (v === null) next.delete(p);
    else next.set(p, v);
  }
  return next;
}

/** The fixture system after the skeleton: what the scenario step starts from. */
async function prepared() {
  const base = composeContext();
  const out = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
  const ctx: V3BuildContext = { ...base, files: apply(base.files, out) };
  return { ctx, site: readSite(ctx.files) as SiteModel, facts: siteFacts(ctx) };
}

const TOP = "/_wizard/photos/00000000-0000-4000-8000-000000000000/1600";

const HOME: PageComposeAnswer = {
  sections: [
    {
      id: "hero",
      pattern: "hero-full-bleed",
      props: {
        title: "Лечим зубы без боли и очередей",
        lead: "Оставьте заявку на сайте — администратор перезвонит за 15 минут и подберёт время приёма.",
        action: { label: "Записаться на приём", href: "#form" },
        image: { src: TOP, alt: "Светлый кабинет клиники с креслом у окна" },
      },
    },
    {
      id: "form",
      pattern: "form-centered",
      props: {
        title: "Запишитесь на приём",
        text: "Оставьте имя и телефон — перезвоним за 15 минут.",
        submit: "Записаться на приём",
        sent: { title: "Заявка отправлена" },
      },
    },
  ],
  seo: {
    title: "Белая линия — лечение зубов без боли",
    description:
      "Стоматологическая клиника «Белая линия»: оставьте заявку на сайте, администратор перезвонит за 15 минут.",
  },
};

const IDEA = {
  after: "hero",
  title: "Как проходит первый приём",
  idea: "Путь пациента по шагам из брифа: заявка на сайте, звонок администратора, приём у врача.",
};

/** A scripted model: each call of a callType gets its next answer (Error — thrown). */
function scripted(answers: Partial<Record<string, (Record<string, unknown> | Error)[]>>) {
  const calls: RouteInput[] = [];
  const n = new Map<string, number>();
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const i = n.get(input.callType) ?? 0;
    n.set(input.callType, i + 1);
    const list = answers[input.callType] ?? [];
    const a = list[Math.min(i, list.length - 1)];
    if (!a) throw new Error(`no answer for ${input.callType}`);
    if (a instanceof Error) throw a;
    const name = input.callType === COMPOSE_CALL_TYPES.page ? "submit_page" : "submit_section";
    return {
      tier: "T1",
      model: "glm-5.3",
      result: { toolCalls: [{ id: `c${calls.length}`, name, args: a }], finishReason: "tool-calls" },
      usage: { inputTokens: 6000, cachedTokens: 0, outputTokens: 1500 },
      creditsCharged: 0.6,
      creditsMilli: 600,
      routeReason: "default_T1",
      scrubbed: true,
      ruFallback: false,
    } as RouteOutput;
  };
  return { route, calls };
}

/** A fixture router over recorded lines (suite unit — by request key; demo — by order of each callType). */
function recorded(suite: "unit" | "demo", lines: FixtureLine[]) {
  const dir = mkdtempSync(join(tmpdir(), "wz-compose-"));
  mkdirSync(join(dir, suite), { recursive: true });
  writeFileSync(join(dir, suite, "compose.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
  const router = createRouter({
    mode: "fixture",
    fixture: { suite, name: "compose", dir },
    registry: llm,
    sink: { write: async () => {} },
    env: {},
  });
  const seen: { callType: string; scrubbed: boolean }[] = [];
  const route = async (input: RouteInput) => {
    const out = await router.route({
      ...input,
      orgPolicy: { ruOnly: false, t1Restricted: false },
      ctx: { orgId: "org" },
    } as RouteInput);
    seen.push({ callType: input.callType, scrubbed: out.scrubbed });
    return out;
  };
  return { route, seen };
}

const noVerify = async () => ({ ok: true, problems: [] as string[] });

describe("page_compose", () => {
  test("recorded answer (by request key): library variants and texts of the scenario, SEO, the budget counted", async () => {
    const { ctx, site, facts } = await prepared();
    const home = site.pages[0];
    if (!home) throw new Error("home");
    const req = pageComposeRequest({
      facts,
      site,
      page: home,
      scenario: LEAD,
      library: PATTERNS,
      offer: true,
    });
    const line = fixtureLine("page_compose", req.messages, [req.tool.definition], {
      name: "submit_page",
      args: HOME,
    });
    const { route, seen } = recorded("unit", [line]);
    const out = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route },
      LEAD,
    );
    expect(seen).toEqual([{ callType: "page_compose", scrubbed: true }]);
    expect(out.pages.map((p) => p.route)).toEqual(["/"]);
    expect(out.pages[0]?.sections.map((s) => [s.id, s.pattern])).toEqual([
      ["header", home.sections[0]?.pattern],
      ["hero", "hero-full-bleed"],
      ["form", "form-centered"],
      ["footer", home.sections.at(-1)?.pattern],
    ]);
    // The binding to the module's entity stays even though the model did not repeat it.
    expect(out.pages[0]?.sections[2]?.props).toMatchObject({ entity: "lead", title: "Запишитесь на приём" });
    const files = apply(ctx.files, out);
    const next = readSite(files) as SiteModel;
    expect(next.pages[0]?.seo).toEqual({ ...HOME.seo, image: TOP });
    expect(JSON.parse(files.get("ui/seo.json") as string).pages["/"].title).toBe(HOME.seo.title);
    expect(files.get("ui/patterns/hero-full-bleed.tsx")).toBeDefined();
    expect(out.spentRub).toBeGreaterThan(0);
    expect(out.spentRub).toBeLessThanOrEqual(ctx.budgetRub);
    for (const p of next.pages) expect(lintErrors(lintSitePage(next, p, facts, PATTERNS))).toEqual([]);
    console.info(`V3-12 page_compose на записанном ответе: ${out.spentRub.toFixed(2)} ₽`);
  });

  test("V3-18: a first screen without a picture keeps the place of the owner's photo (GS-landing-2)", async () => {
    const { ctx, site } = await prepared();
    expect(site.pages[0]?.sections.find((s) => s.type === "hero")?.photos?.image).toBe("top");
    // The model chose the typographic first screen («Фото: нет» → variants without photos).
    const { image: _image, ...text } = HOME.sections[0]?.props ?? {};
    const typographic = {
      ...HOME,
      sections: [{ id: "hero", pattern: "hero-typographic", props: text }, ...HOME.sections.slice(1)],
    };
    const { route, calls } = scripted({ page_compose: [typographic] });
    const out = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route },
      LEAD,
    );
    expect(JSON.stringify(calls[0]?.messages)).toContain("Место для фото владельца");
    const next = readSite(apply(ctx.files, out)) as SiteModel;
    const hero = next.pages[0]?.sections.find((s) => s.type === "hero");
    expect(hero?.pattern).not.toBe("hero-typographic");
    expect(hero?.props.title).toBe(text.title);
    expect(apply(ctx.files, out).get(next.pages[0]?.file as string)).toContain('photo.one("top"');
  });

  test("V3-18: the model may not drop a section with a place of the owner's photo", async () => {
    const { ctx } = await prepared();
    const dropped = { ...HOME, sections: HOME.sections.filter((s) => s.id !== "hero") };
    const { route, calls } = scripted({ page_compose: [dropped, HOME] });
    await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario({ ...ctx, route }, LEAD);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages.at(-1))).toContain("REQUIRED");
  });

  test("repairs: invented facts, a superlative and a variant of another type go back to the model", async () => {
    const { ctx } = await prepared();
    const bad = {
      ...HOME,
      sections: [
        {
          id: "hero",
          pattern: "hero-full-bleed",
          props: {
            ...(HOME.sections[0]?.props ?? {}),
            title: "Лучшая клиника Казани: более 1000 довольных пациентов",
          },
        },
        { id: "form", pattern: "hero-split", props: { title: "Запишитесь" } },
      ],
    };
    const { route, calls } = scripted({ page_compose: [bad, HOME] });
    const out = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route },
      LEAD,
    );
    expect(calls).toHaveLength(2);
    const repair = JSON.stringify(calls[1]?.messages.at(-1));
    for (const code of ["SUPERLATIVE", "UNTRACED_NUMBER", "WRONG_VARIANT"]) expect(repair).toContain(code);
    expect(out.pages[0]?.sections[1]?.props).toMatchObject({ title: "Лечим зубы без боли и очередей" });
  });

  test("an answer that never passes keeps the skeleton; owner scenarios and an empty budget call no model", async () => {
    const { ctx } = await prepared();
    const bad = {
      ...HOME,
      sections: [{ id: "hero", pattern: "hero-full-bleed", props: { title: "№ 1 в городе" } }],
    };
    const never = scripted({ page_compose: [bad] });
    const kept = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route: never.route },
      LEAD,
    );
    expect(never.calls).toHaveLength(3);
    expect(kept.notes.join("\n")).toContain("не прошли проверку");
    expect(kept.files.size).toBe(0);

    const owner = scripted({});
    const r1 = await createPageComposer({ patterns: PATTERNS }).scenario(
      { ...ctx, route: owner.route },
      OWNER,
    );
    expect(owner.calls).toHaveLength(0);
    expect(r1).toMatchObject({ pages: [], spentRub: 0 });
    expect(r1.notes[0]).toContain("в кабинетах");

    const poor = scripted({ page_compose: [HOME] });
    const r2 = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route: poor.route, budgetRub: 0.05 },
      LEAD,
    );
    expect(poor.calls).toHaveLength(0);
    expect(r2.spentRub).toBe(0);
    expect(r2.notes.join("\n")).toContain("Бюджет шага исчерпан");
  });

  test("a scenario of the catalog module works on its page", async () => {
    const { ctx } = await prepared();
    const answer: PageComposeAnswer = {
      sections: [
        {
          id: "hero",
          pattern: "hero-centered",
          props: { title: "Цены на лечение", action: { label: "Оставить заявку", href: "/#form" } },
        },
        {
          id: "catalog",
          pattern: "catalog-list",
          props: { title: "Услуги и цены", empty: "В каталоге пока нет позиций" },
        },
        {
          id: "cta",
          pattern: "cta-card",
          props: { title: "Запишитесь на приём", action: { label: "Оставить заявку", href: "/#form" } },
        },
      ],
      seo: {
        title: "Цены на лечение — Белая линия",
        description: "Каталог услуг стоматологической клиники «Белая линия» с ценами и заявкой на приём.",
      },
    };
    // The catalog showcase is bound to the module: the model may not drop it, nor take a variant without the items'
    // action (a price list): the items lead to the request form of the site (GS-catalog-4).
    const dropped = { ...answer, sections: answer.sections.filter((s) => s.id !== "catalog") };
    const priceList = {
      ...answer,
      sections: answer.sections.map((s) =>
        s.id === "catalog" ? { ...s, pattern: "catalog-price-list" } : s,
      ),
    };
    const { route, calls } = scripted({ page_compose: [dropped, priceList, answer] });
    const out = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route },
      PRICES,
    );
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[1]?.messages.at(-1))).toContain("Секцию catalog убирать нельзя");
    // The variants the tool offers for the showcase keep the items' action: no price list among them.
    const refused = JSON.stringify(calls[2]?.messages.at(-1));
    expect(refused).toContain("sections.1.pattern");
    expect(refused).toContain("catalog-list");
    expect(refused).not.toContain("catalog-price-list");
    expect(out.pages.map((p) => p.route)).toEqual(["/services"]);
    expect(out.pages[0]?.sections[1]?.props).toMatchObject({ title: "Цены на лечение" });
    // The binding stays the module's: the entity, the sections entity and the items' action are not the model's.
    expect(out.pages[0]?.sections[2]).toMatchObject({
      pattern: "catalog-list",
      props: {
        entity: "service",
        title: "Услуги и цены",
        itemAction: { label: "Оставить заявку", path: "/#form" },
      },
    });
  });

  test("the site's action rules hold over the model's page: the hero leads to the form, the form says «sent»", async () => {
    const { ctx } = await prepared();
    // The model points the first screen elsewhere and rewrites the «sent» heading — both valid answers of the tool.
    const answer: PageComposeAnswer = {
      ...HOME,
      sections: HOME.sections.map((s) =>
        s.id === "hero"
          ? { ...s, props: { ...s.props, action: { label: "Записаться на приём", href: "/services" } } }
          : {
              ...s,
              props: { ...s.props, sent: { title: "Спасибо, мы перезвоним", text: "В течение часа." } },
            },
      ),
    };
    const { route } = scripted({ page_compose: [answer] });
    const out = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route },
      LEAD,
    );
    const files = apply(ctx.files, out);
    const home = readSite(files)?.pages.find((p) => p.route === "/");
    const hero = home?.sections.find((s) => s.type === "hero");
    const form = home?.sections.find((s) => s.type === "form");
    expect(hero?.props.action).toEqual({ label: "Записаться на приём", href: "#form" });
    expect(form?.props.sent).toEqual({ title: "Заявка отправлена", text: "В течение часа." });
    // The page file carries the same: the anchor of the form section and the hero's link to it.
    const source = files.get(home?.file ?? "") ?? "";
    expect(source).toContain('<div id="form">');
    expect(source).toContain('"action":{"label":"Записаться на приём","href":"#form"}');
    expect(source).toContain('"sent":{"title":"Заявка отправлена","text":"В течение часа."}');
  });
});

describe("signature sections", () => {
  test("recorded answers: the signature section is written as code, passes the linter and G0 and joins the page", async () => {
    const { ctx, site, facts } = await prepared();
    const home = site.pages[0];
    if (!home) throw new Error("home");
    const page = pageComposeRequest({
      facts,
      site,
      page: home,
      scenario: LEAD,
      library: PATTERNS,
      offer: true,
    });
    const sig = signatureRequest({
      facts,
      site,
      page: home,
      idea: IDEA,
      design: ctx.design,
      library: PATTERNS,
    });
    const { route, seen } = recorded("demo", [
      fixtureLine("page_compose", page.messages, [page.tool.definition], {
        name: "submit_page",
        args: { ...HOME, signature: IDEA },
      }),
      fixtureLine("signature_section", sig.messages, [sig.tool.definition], {
        name: "submit_section",
        args: SIGNATURE_OK,
      }),
    ]);
    const out = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route },
      LEAD,
    );
    expect(seen.map((s) => s.callType)).toEqual(["page_compose", "signature_section"]);
    expect(seen.every((s) => s.scrubbed)).toBe(true);
    const files = apply(ctx.files, out);
    expect(files.get("ui/sections/first-visit.tsx")).toBe(SIGNATURE_OK.source);
    const next = readSite(files) as SiteModel;
    const ids = next.pages[0]?.sections.map((s) => s.id);
    expect(ids).toEqual(["header", "hero", "first-visit", "form", "footer"]);
    expect(files.get(next.pages[0]?.file as string)).toContain('from "../../sections/first-visit"');
    expect(out.notes.join("\n")).toContain("Фирменная секция «Как проходит первый приём»");
    for (const p of next.pages)
      expect(
        lintErrors(
          lintSitePage(
            next,
            p,
            facts,
            PATTERNS,
            new Map([["ui/sections/first-visit.tsx", SIGNATURE_OK.source]]),
          ),
        ),
      ).toEqual([]);
    const report = await runG0(
      {
        spec: withSitePages(ctx.spec, next),
        prevSpec: null,
        specVersion: 0,
        files,
        env: "draft",
        systemKey: "v3_sig",
        db: undefined as never,
      },
      { only: ["G0-IMP-01", "G0-SEC-01", "G0-TS-01", "G0-BUILD-01", "G0-SPEC-04"] },
    );
    expect(report.checks.filter((c) => c.status === "fail" || c.status === "error")).toEqual([]);
    // The site now has one of its two signature sections: the next page may still get one, a third — never.
    expect(signatureOffer(next, next.pages[1] as never)).toBe(true);
    const two = {
      ...next,
      pages: next.pages.map((p, i) =>
        i === 1
          ? {
              ...p,
              sections: [
                ...p.sections,
                { id: "x", type: "signature" as const, pattern: "signature", props: {} },
              ],
            }
          : p,
      ),
    };
    expect(signatureOffer(two, two.pages[2] as never)).toBe(false);
    // A later scenario on the same page rewrites its texts and keeps the signature section in place.
    const again = scripted({ page_compose: [HOME] });
    const later = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, files, route: again.route },
      LEAD,
    );
    expect(again.calls).toHaveLength(1);
    expect(JSON.stringify(again.calls[0]?.tools)).not.toContain('"signature"');
    expect(later.pages[0]?.sections.map((s) => s.id)).toEqual([
      "header",
      "hero",
      "first-visit",
      "form",
      "footer",
    ]);
    expect(later.notes.join("\n")).not.toContain("Проверка страницы");
    console.info(`V3-12 страница и фирменная секция на записанных ответах: ${out.spentRub.toFixed(2)} ₽`);
  }, 120_000);

  test("a signature section that fails the linter gets a library pattern in its place", async () => {
    const { ctx, facts } = await prepared();
    const loud = {
      ...SIGNATURE_OK,
      source: SIGNATURE_OK.source.replace(
        "bg-background",
        "bg-linear-to-r from-purple-500 to-indigo-500 text-[#fff]",
      ),
    };
    const { route, calls } = scripted({
      page_compose: [{ ...HOME, signature: IDEA }],
      signature_section: [loud],
    });
    const out = await createPageComposer({
      patterns: PATTERNS,
      registry: llm,
      verify: noVerify,
    }).scenario({ ...ctx, route }, LEAD);
    expect(calls.filter((c) => c.callType === "signature_section")).toHaveLength(3);
    const files = apply(ctx.files, out);
    const next = readSite(files) as SiteModel;
    const placed = next.pages[0]?.sections.find((s) => s.id === "signature-fallback");
    expect(placed?.pattern).toMatch(/^cta-/);
    expect(placed?.props.title).toBe(IDEA.title);
    expect([...files.keys()].some((p) => p.startsWith("ui/sections/"))).toBe(false);
    expect(out.notes.join("\n")).toMatch(
      /Фирменная секция «Как проходит первый приём» не прошла проверки кода — на её месте паттерн/,
    );
    for (const p of next.pages) expect(lintErrors(lintSitePage(next, p, facts, PATTERNS))).toEqual([]);
  });

  test("a signature section that passes the linter but not G0 (build) gets one fix round, then a pattern", async () => {
    const { ctx } = await prepared();
    const broken = {
      ...SIGNATURE_OK,
      source: `import { Step } from "./first-visit-steps";\n${SIGNATURE_OK.source.replace(/^type Step = .*$/m, "")}`,
    };
    const { route, calls } = scripted({
      page_compose: [{ ...HOME, signature: IDEA }],
      signature_section: [broken],
    });
    const out = await createPageComposer({ patterns: PATTERNS, registry: llm }).scenario(
      { ...ctx, route },
      LEAD,
    );
    const sigCalls = calls.filter((c) => c.callType === "signature_section");
    expect(sigCalls).toHaveLength(2);
    expect(JSON.stringify(sigCalls[1]?.messages.at(-1))).toContain("G0-");
    const next = readSite(apply(ctx.files, out)) as SiteModel;
    expect(next.pages[0]?.sections.some((s) => s.id === "signature-fallback")).toBe(true);
    expect(out.notes.join("\n")).toContain("не собралась");
  }, 120_000);
});
