// V3-12 / V4-06 acceptance: a scenario of the brief brought to its page by the models (scripted routes, no live calls).
// The model writes the page as free code — sections of React + Tailwind on the tokens — and keeps the SDK components
// (the catalog, the request form, the contacts); the page passes the pattern and page lint, the SDK gate (a required
// component removed — the answer goes back) and G0 (real build in two tests); the home page's first screen gets a
// rival of another family and a judge by screenshots. Every call fits the step's budget; owner scenarios do not
// touch the public pages.
import type { BriefScenario } from "@wizard/appspec";
import { createRegistry, type RouteInput, type RouteOutput } from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import {
  createPageComposer,
  lintErrors,
  lintSitePage,
  PAGE_CODE_TOOL,
  type PageCodeAnswer,
  pageCodeMessages,
  pageCodeRequest,
  RIVAL_TOOL,
  readSite,
  type SiteModel,
  type SitePage,
  sdkGate,
  siteFacts,
} from "../src/builder/v3/compose/index.js";
import type { V3BuildContext, V3ComposeResult } from "../src/builder/v3/contract.js";
import type { CriticInspectInput } from "../src/builder/v3/critic/types.js";
import { BRIEF, composeContext, HERO_CODE, SIGNATURE_OK } from "./v3-compose-fixtures.js";

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
  const ctx: V3BuildContext = { ...base, files: apply(base.files, out), budgetRub: 200 };
  return { ctx, site: readSite(ctx.files) as SiteModel, facts: siteFacts(ctx) };
}

/** The home page as code: the first screen and a section written by the model, the SDK components kept. */
const HOME: PageCodeAnswer = {
  sections: [
    { kind: "code", id: "hero", title: HERO_CODE.title, source: HERO_CODE.source, props: HERO_CODE.props },
    {
      kind: "code",
      id: "first-visit",
      title: SIGNATURE_OK.title,
      source: SIGNATURE_OK.source,
      props: SIGNATURE_OK.props,
    },
    { kind: "keep", id: "catalog", props: { title: "Услуги и цены" } },
    { kind: "keep", id: "form" },
    { kind: "keep", id: "contacts" },
  ],
  seo: {
    title: "Белая линия — лечение зубов без боли",
    description:
      "Стоматологическая клиника «Белая линия»: оставьте заявку на сайте, администратор перезвонит за 15 минут.",
  },
};

const RIVAL = {
  title: "Первый экран: крупный заголовок",
  props: { ...HERO_CODE.props, title: "Запись к стоматологу за 15 минут" },
  source: HERO_CODE.source.replace("md:grid-cols-[1.2fr_1fr]", "md:grid-cols-[1fr_1.4fr]"),
};

const answer = (tool: string, args: unknown, model: string, n: number): RouteOutput =>
  ({
    tier: "T1",
    model,
    result: { toolCalls: [{ id: `c${n}`, name: tool, args }], finishReason: "tool-calls" },
    usage: { inputTokens: 6000, cachedTokens: 0, outputTokens: 1500 },
    creditsCharged: 0.6,
    creditsMilli: 600,
    routeReason: "default_T1",
    scrubbed: false,
    ruFallback: false,
  }) as RouteOutput;

/** A scripted model: each call of a callType gets its next answer (Error — thrown); models as in the v4 route. */
function scripted(answers: Partial<Record<string, unknown[]>>) {
  const calls: RouteInput[] = [];
  const n = new Map<string, number>();
  const MODEL: Record<string, string> = {
    page_compose: "kimi-k3",
    signature_section: "glm-5.3",
    critic_visual: "qwen3.6-35b",
  };
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const i = n.get(input.callType) ?? 0;
    n.set(input.callType, i + 1);
    const list = answers[input.callType] ?? [];
    const a = list[Math.min(i, list.length - 1)];
    if (a === undefined) throw new Error(`no answer for ${input.callType}`);
    if (a instanceof Error) throw a;
    return answer(input.tools?.[0]?.name ?? "", a, MODEL[input.callType] ?? "glm-5.3", calls.length);
  };
  return { route, calls };
}

const noVerify = async () => ({ ok: true, problems: [] as string[] });
const composer = (o: Parameters<typeof createPageComposer>[0] = {}) =>
  createPageComposer({ patterns: PATTERNS, registry: llm, verify: noVerify, firstScreen: false, ...o });

describe("V4-06: the page as free code", () => {
  test("the model writes the sections as code, keeps the SDK components; files, site model, SEO, budget", async () => {
    const { ctx, facts } = await prepared();
    const { route, calls } = scripted({ page_compose: [HOME] });
    const r = await composer().scenario({ ...ctx, route }, LEAD);
    expect(calls.map((c) => c.callType)).toEqual(["page_compose"]);
    expect(calls[0]?.tools?.[0]?.name).toBe(PAGE_CODE_TOOL);
    const files = apply(ctx.files, r);
    expect(files.get("ui/sections/home-hero.tsx")).toBe(HERO_CODE.source);
    expect(files.get("ui/sections/home-first-visit.tsx")).toBe(SIGNATURE_OK.source);
    const site = readSite(files) as SiteModel;
    const home = site.pages[0] as SitePage;
    expect(home.sections.map((s) => `${s.id}:${s.type === "signature" ? "code" : s.pattern}`)).toEqual([
      "header:header-floating",
      "hero:code",
      "first-visit:code",
      "catalog:catalog-list",
      "form:form-inline",
      "contacts:contacts-cards",
      "footer:footer-contact-first",
    ]);
    expect(home.sections.find((s) => s.id === "catalog")?.props.title).toBe("Услуги и цены");
    expect(home.seo.title).toBe(HOME.seo.title);
    expect(files.get(home.file)).toContain('from "../../sections/home-hero"');
    expect(lintErrors(lintSitePage(site, home, facts, PATTERNS, files))).toEqual([]);
    expect(r.spentRub).toBeCloseTo(3, 5);
    expect(r.notes.join("\n")).toContain("написана кодом");
  });

  test("the prompt: taste rules, code rules, library patterns as examples, the SDK components with their schemas", async () => {
    const { ctx, site, facts } = await prepared();
    const [system, user] = pageCodeMessages({
      facts,
      site,
      page: site.pages[0] as SitePage,
      scenario: LEAD,
      design: ctx.design,
    });
    expect(system?.content).toContain("Интересно, но никогда не уродливо");
    expect(system?.content).toContain("фиолетовых");
    expect(system?.content).toContain("Пример уровня — паттерн библиотеки hero-");
    expect(system?.content).not.toMatch(/Для каждой секции выбери вариант/);
    expect(user?.content).toContain("- form (form, компонент form-inline");
    expect(user?.content).toContain("схема props");
    expect(user?.content).toContain(ctx.design.fonts.display.family);
  });

  test("SDK gate: a removed component is refused and goes back to the model", async () => {
    const { ctx, site, facts } = await prepared();
    const home = site.pages[0] as SitePage;
    const req = pageCodeRequest({ facts, site, page: home, scenario: LEAD, design: ctx.design });
    const noForm = { ...HOME, sections: HOME.sections.filter((s) => s.id !== "form") };
    const issues = (await req.tool.check?.(noForm)) ?? [];
    expect(issues.map((i) => i.code)).toContain("SDK_REQUIRED");
    // The gate itself: the page without its form fails, the same page passes.
    const without = { ...home, sections: home.sections.filter((s) => s.id !== "form") };
    expect(sdkGate(home, without)).toEqual([expect.stringContaining("«form»")]);
    expect(sdkGate(home, home)).toEqual([]);
    // Through the step: the first answer drops the form, the repair keeps it.
    const { route, calls } = scripted({ page_compose: [noForm, HOME] });
    const r = await composer().scenario({ ...ctx, route }, LEAD);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages)).toContain("SDK_REQUIRED");
    expect(readSite(apply(ctx.files, r))?.pages[0]?.sections.some((s) => s.id === "form")).toBe(true);
  });

  test("lint: raw colours, the default palette and a missing hero go back; a page that never passes stays", async () => {
    const { ctx } = await prepared();
    const hero = HOME.sections[0] as PageCodeAnswer["sections"][number];
    const loud = {
      ...HOME,
      sections: [
        { ...hero, source: HERO_CODE.source.replace("bg-background", "bg-[#7c3aed] text-blue-500") },
        ...HOME.sections.slice(1),
      ],
    };
    const noHero = { ...HOME, sections: HOME.sections.slice(1) };
    const never = scripted({ page_compose: [loud, noHero, loud] });
    const r = await composer().scenario({ ...ctx, route: never.route }, LEAD);
    expect(never.calls).toHaveLength(3);
    const repairs = JSON.stringify(never.calls.slice(1).map((c) => c.messages.at(-1)));
    expect(repairs).toMatch(/ARBITRARY_COLOR|PALETTE|RAW_COLOR/);
    expect(repairs).toContain("HERO_FIRST");
    expect(r.files.size).toBe(0);
    expect(r.notes.join("\n")).toContain("осталась прежней");
  });

  test("owner scenarios and an empty budget call no model", async () => {
    const { ctx } = await prepared();
    const owner = scripted({});
    const r1 = await composer().scenario({ ...ctx, route: owner.route }, OWNER);
    expect(owner.calls).toHaveLength(0);
    expect(r1).toMatchObject({ pages: [], spentRub: 0 });
    const poor = scripted({ page_compose: [HOME] });
    const r2 = await composer().scenario({ ...ctx, route: poor.route, budgetRub: 0.05 }, LEAD);
    expect(poor.calls).toHaveLength(0);
    expect(r2.notes.join("\n")).toContain("Бюджет шага исчерпан");
  });

  test("a scenario of the catalog module writes its page and keeps the catalog component", async () => {
    const { ctx } = await prepared();
    const services: PageCodeAnswer = {
      sections: [
        {
          kind: "code",
          id: "hero",
          title: HERO_CODE.title,
          source: HERO_CODE.source,
          // Another page: the action leads to the form of the home page.
          props: { ...HERO_CODE.props, action: { label: "Записаться на приём", href: "/#form" } },
        },
        { kind: "keep", id: "catalog" },
      ],
      seo: {
        title: "Услуги и цены клиники «Белая линия»",
        description:
          "Услуги стоматологии «Белая линия» с ценами: выберите и оставьте заявку на сайте за минуту.",
      },
    };
    const { route } = scripted({ page_edit: [services] });
    const r = await composer().scenario({ ...ctx, route }, PRICES);
    const page = readSite(apply(ctx.files, r))?.pages.find((p) => p.route === "/services");
    const ids = page?.sections.map((s) => s.id) ?? [];
    // The site's action rules may add the way to the main action after the catalog (siteRules).
    expect(ids.slice(0, 3)).toEqual(["header", "hero", "catalog"]);
    expect(ids.at(-1)).toBe("footer");
    expect(apply(ctx.files, r).get("ui/sections/services-hero.tsx")).toBe(HERO_CODE.source);
  });
});

describe("V4-06: the first screen — two candidates of different families and a judge", () => {
  const fakeInspect = (seen: CriticInspectInput[]) => async (input: CriticInspectInput) => {
    seen.push(input);
    return {
      ok: true,
      problems: [],
      shots: input.shots.map((s) => ({
        ...s,
        mime: "image/png" as const,
        data: "iVBORw0KGgo=",
        px: { width: s.maxWidth, height: s.maxHeight },
        sections: ["hero 0–800"],
      })),
    };
  };

  test("the rival comes from another family; the judge of a third family picks it by the screenshots", async () => {
    const { ctx } = await prepared();
    const seen: CriticInspectInput[] = [];
    const { route, calls } = scripted({
      page_compose: [HOME],
      signature_section: [RIVAL],
      critic_visual: [{ pick: "B", why: "Заголовок крупнее и оффер читается сразу." }],
    });
    const r = await composer({ firstScreen: true, inspect: fakeInspect(seen) }).scenario(
      { ...ctx, route },
      LEAD,
    );
    expect(calls.map((c) => c.callType)).toEqual(["page_compose", "signature_section", "critic_visual"]);
    expect(calls[1]?.tools?.[0]?.name).toBe(RIVAL_TOOL);
    expect(calls[1]?.avoidFamilies).toEqual(["kimi"]);
    expect(calls[2]?.avoidFamilies).toEqual(["kimi", "glm"]);
    expect(calls[2]?.messages.filter((m) => m.role === "user" && m.attachments?.length)).toHaveLength(2);
    expect(seen.map((s) => s.shots.map((x) => x.width))).toEqual([
      [390, 1440],
      [390, 1440],
    ]);
    const files = apply(ctx.files, r);
    expect(files.get("ui/sections/home-hero.tsx")).toBe(RIVAL.source);
    expect(readSite(files)?.pages[0]?.sections.find((s) => s.id === "hero")?.props.title).toBe(
      RIVAL.props.title,
    );
    expect(r.notes.join("\n")).toContain("судья выбрал вариант B");
  });

  test("without a browser the first candidate stays; a failed rival changes nothing", async () => {
    const { ctx } = await prepared();
    const a = scripted({ page_compose: [HOME], signature_section: [RIVAL] });
    const r = await composer({ firstScreen: true }).scenario({ ...ctx, route: a.route }, LEAD);
    expect(apply(ctx.files, r).get("ui/sections/home-hero.tsx")).toBe(HERO_CODE.source);
    expect(r.notes.join("\n")).toContain("остался первый");
    const b = scripted({ page_compose: [HOME], signature_section: [new Error("провайдер недоступен")] });
    const r2 = await composer({ firstScreen: true }).scenario({ ...ctx, route: b.route }, LEAD);
    expect(apply(ctx.files, r2).get("ui/sections/home-hero.tsx")).toBe(HERO_CODE.source);
  });
});

describe("V4-06: G0 of the system decides (real build)", () => {
  test("code that does not build gets one fix round with the G0 problems, then the page stays", async () => {
    const { ctx } = await prepared();
    const brokenSource = `import { Step } from "./first-visit-steps";\n${SIGNATURE_OK.source.replace(/^type Step = .*$/m, "")}`;
    const broken = {
      ...HOME,
      sections: HOME.sections.map((s) => (s.id === "first-visit" ? { ...s, source: brokenSource } : s)),
    };
    const { route, calls } = scripted({ page_compose: [broken] });
    const r = await createPageComposer({ patterns: PATTERNS, registry: llm, firstScreen: false }).scenario(
      { ...ctx, route },
      LEAD,
    );
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages.at(-1))).toContain("G0-");
    expect(r.notes.join("\n")).toContain("не собрался");
    expect(apply(ctx.files, r).has("ui/sections/home-first-visit.tsx")).toBe(false);
  }, 180_000);

  test("good code builds: the page with its code sections passes G0", async () => {
    const { ctx } = await prepared();
    const { route, calls } = scripted({ page_compose: [HOME] });
    const r = await createPageComposer({ patterns: PATTERNS, registry: llm, firstScreen: false }).scenario(
      { ...ctx, route },
      LEAD,
    );
    expect(calls).toHaveLength(1);
    expect(apply(ctx.files, r).get("ui/sections/home-hero.tsx")).toBe(HERO_CODE.source);
  }, 180_000);
});
