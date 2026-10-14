// V4-06 speed: the page by sections — a short plan call, then one call per code section at once; the page assembled
// by code and checked as before, only a failing section written again; mechanical slips fixed by code (no call).
import type { BriefScenario } from "@wizard/appspec";
import { createRegistry, type RouteInput, type RouteOutput } from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { createPageComposer, readSite, type SiteModel } from "../src/builder/v3/compose/index.js";
import { withMotionImports } from "../src/builder/v3/compose/motion-imports.js";
import {
  autofixSection,
  normalizePlan,
  PAGE_PLAN_TOOL,
  type PagePlan,
  SECTION_CODE_TOOL,
  sectionIssues,
} from "../src/builder/v3/compose/page-sections.js";
import { anchorIssues, retargetAnchors } from "../src/builder/v3/compose/page-step.js";
import type { V3BuildContext, V3ComposeResult } from "../src/builder/v3/contract.js";
import { BRIEF, composeContext, HERO_CODE, SIGNATURE_OK } from "./v3-compose-fixtures.js";

const llm = createRegistry({ buildDefaultTier: "T1" });
const LEAD = BRIEF.scenarios[0] as BriefScenario;

function apply(files: ReadonlyMap<string, string>, out: V3ComposeResult): Map<string, string> {
  const next = new Map(files);
  for (const [p, v] of out.files) v === null ? next.delete(p) : next.set(p, v);
  return next;
}

async function prepared() {
  const base = composeContext();
  const out = await createPageComposer({ patterns: PATTERNS }).skeleton(base);
  return { ...base, files: apply(base.files, out), budgetRub: 200 } as V3BuildContext;
}

const PLAN: PagePlan = {
  sections: [
    {
      kind: "code",
      id: "hero",
      title: HERO_CODE.title,
      idea: "Оффер слева, высокое фото справа, одно действие.",
      props: HERO_CODE.props,
    },
    {
      kind: "code",
      id: "first-visit",
      title: SIGNATURE_OK.title,
      idea: "Три шага первого визита крупными цифрами.",
      props: SIGNATURE_OK.props,
    },
    { kind: "keep", id: "catalog", props: { title: "Услуги" } },
    { kind: "keep", id: "form" },
    { kind: "keep", id: "contacts" },
  ],
  seo: {
    title: "Белая линия — лечение зубов без боли",
    description:
      "Стоматологическая клиника «Белая линия»: оставьте заявку на сайте, администратор перезвонит за 15 минут.",
  },
};

const out = (tool: string, args: unknown, n: number): RouteOutput =>
  ({
    tier: "T1",
    model: "glm-5.3",
    result: { toolCalls: [{ id: `c${n}`, name: tool, args }], finishReason: "tool-calls" },
    usage: { inputTokens: 3000, cachedTokens: 0, outputTokens: 600 },
    creditsCharged: 0.2,
    creditsMilli: 200,
    routeReason: "default_T1",
    scrubbed: false,
    ruFallback: false,
  }) as RouteOutput;

/** A model that plans the page and writes each section by the id in its prompt; `sources` per id, a list per round. */
function model(sources: Record<string, string[]>) {
  const calls: RouteInput[] = [];
  const round = new Map<string, number>();
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    calls.push(input);
    const tool = input.tools?.[0]?.name ?? "";
    if (tool === PAGE_PLAN_TOOL) return out(tool, PLAN, calls.length);
    const text = input.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const id = /## Твоя секция: ([a-z-]+)/.exec(text)?.[1] as string;
    const k = round.get(id) ?? 0;
    round.set(id, k + 1);
    const list = sources[id] ?? [];
    return out(tool, { source: list[Math.min(k, list.length - 1)] }, calls.length);
  };
  return { route, calls };
}

const composer = (o: Parameters<typeof createPageComposer>[0] = {}) =>
  createPageComposer({
    patterns: PATTERNS,
    registry: llm,
    verify: async () => ({ ok: true, problems: [] }),
    firstScreen: false,
    sections: true,
    ...o,
  });

describe("V4-06 speed: the page by sections", () => {
  test("a plan call, then one call per code section; the page assembled like the one-call page", async () => {
    const ctx = await prepared();
    const m = model({ hero: [HERO_CODE.source], "first-visit": [SIGNATURE_OK.source] });
    const r = await composer().scenario({ ...ctx, route: m.route }, LEAD);
    expect(m.calls.map((c) => c.tools?.[0]?.name)).toEqual([
      PAGE_PLAN_TOOL,
      SECTION_CODE_TOOL,
      SECTION_CODE_TOOL,
    ]);
    const files = apply(ctx.files, r);
    expect(files.get("ui/sections/home-hero.tsx")).toBe(HERO_CODE.source);
    expect(files.get("ui/sections/home-first-visit.tsx")).toBe(SIGNATURE_OK.source);
    const home = (readSite(files) as SiteModel).pages[0];
    expect(home?.sections.map((s) => s.id)).toEqual([
      "header",
      "hero",
      "first-visit",
      "catalog",
      "form",
      "contacts",
      "footer",
    ]);
    expect(home?.author).toBe("glm-5.3");
    expect(r.notes.join(" ")).toContain("написана по секциям");
  });

  test("a section that fails the checks is written again alone; the other one is not asked twice", async () => {
    const ctx = await prepared();
    const raw = SIGNATURE_OK.source.replace("bg-background", "bg-[#ffeedd]");
    const m = model({ hero: [HERO_CODE.source], "first-visit": [raw, SIGNATURE_OK.source] });
    const r = await composer().scenario({ ...ctx, route: m.route }, LEAD);
    const ids = m.calls
      .filter((c) => c.tools?.[0]?.name === SECTION_CODE_TOOL)
      .map((c) => /## Твоя секция: ([a-z-]+)/.exec(String(c.messages[1]?.content))?.[1]);
    expect(ids.filter((x) => x === "hero")).toHaveLength(1);
    expect(ids.filter((x) => x === "first-visit")).toHaveLength(2);
    expect(apply(ctx.files, r).get("ui/sections/home-first-visit.tsx")).toBe(SIGNATURE_OK.source);
  });

  test("G0 names a section file: only that section is written again", async () => {
    const ctx = await prepared();
    const broken = SIGNATURE_OK.source.replace("export default function", "export default function /*x*/");
    let seen = 0;
    const verify = async (_s: unknown, f: ReadonlyMap<string, string>) => {
      if (!f.get("ui/sections/home-first-visit.tsx")?.includes("/*x*/")) return { ok: true, problems: [] };
      seen += 1;
      return { ok: false, problems: ["G0-TS-01: ошибка типов в ui/sections/home-first-visit.tsx"] };
    };
    const m = model({ hero: [HERO_CODE.source], "first-visit": [broken, SIGNATURE_OK.source] });
    const r = await composer({ verify }).scenario({ ...ctx, route: m.route }, LEAD);
    expect(seen).toBe(1);
    expect(m.calls).toHaveLength(4);
    expect(apply(ctx.files, r).get("ui/sections/home-first-visit.tsx")).toBe(SIGNATURE_OK.source);
  });

  test("G0 names a line of the page file: the section wrapped there hears it with the props hint", async () => {
    const ctx = await prepared();
    const broken = SIGNATURE_OK.source.replace("export default function", "export default function /*x*/");
    const verify = async (_s: unknown, f: ReadonlyMap<string, string>) => {
      if (!f.get("ui/sections/home-first-visit.tsx")?.includes("/*x*/")) return { ok: true, problems: [] };
      const lines = (f.get("ui/pages/site/Home.tsx") ?? "").split("\n");
      const at = lines.findIndex((l) => l.includes('<div id="first-visit">')) + 2;
      return { ok: false, problems: [`G0-TS-01: Ошибка типов в ui/pages/site/Home.tsx:${at} (TS2322)`] };
    };
    const m = model({ hero: [HERO_CODE.source], "first-visit": [broken, SIGNATURE_OK.source] });
    const r = await composer({ verify }).scenario({ ...ctx, route: m.route }, LEAD);
    const fix = m.calls
      .filter((c) => String(c.messages[1]?.content).includes("## Твоя секция: first-visit"))
      .at(-1);
    expect(JSON.stringify(fix?.messages)).toContain("props секции из плана не подходят под тип props");
    expect(apply(ctx.files, r).get("ui/sections/home-first-visit.tsx")).toBe(SIGNATURE_OK.source);
  });

  test("a section linking to a missing anchor is written again alone with the anchor issue", async () => {
    const ctx = await prepared();
    const dead = SIGNATURE_OK.source.replace(
      /(<section[^>]*>)/,
      '$1<a href="#order" className="text-primary">Заказать</a>',
    );
    const m = model({ hero: [HERO_CODE.source], "first-visit": [dead, SIGNATURE_OK.source] });
    const r = await composer().scenario({ ...ctx, route: m.route }, LEAD);
    const asks = m.calls.filter((c) =>
      String(c.messages[1]?.content).includes("## Твоя секция: first-visit"),
    );
    expect(asks).toHaveLength(2);
    expect(JSON.stringify(asks[1]?.messages)).toContain("Якоря #order на странице нет");
    expect(
      m.calls.filter((c) => String(c.messages[1]?.content).includes("## Твоя секция: hero")),
    ).toHaveLength(1);
    expect(apply(ctx.files, r).get("ui/sections/home-first-visit.tsx")).toBe(SIGNATURE_OK.source);
  });

  test("a section that never passes is dropped: the page is assembled from the ones that did (not the skeleton)", async () => {
    const ctx = await prepared();
    const broken = SIGNATURE_OK.source.replace("export default function", "export default function /*x*/");
    const verify = async (_s: unknown, f: ReadonlyMap<string, string>) =>
      f.get("ui/sections/home-first-visit.tsx")?.includes("/*x*/")
        ? { ok: false, problems: ["G0-TS-01: ошибка типов в ui/sections/home-first-visit.tsx"] }
        : { ok: true, problems: [] };
    const m = model({ hero: [HERO_CODE.source], "first-visit": [broken] });
    const r = await composer({ verify }).scenario({ ...ctx, route: m.route }, LEAD);
    const files = apply(ctx.files, r);
    expect(files.get("ui/sections/home-hero.tsx")).toBe(HERO_CODE.source);
    expect(files.has("ui/sections/home-first-visit.tsx")).toBe(false);
    expect((readSite(files) as SiteModel).pages[0]?.sections.map((x) => x.id)).toEqual([
      "header",
      "hero",
      "catalog",
      "form",
      "contacts",
      "footer",
    ]);
    expect(r.notes.join(" ")).toMatch(/собрана без секций «[^»]+»: они не прошли проверки \(G0-TS-01/);
  });

  test("a hero that never passes keeps the page as it was; the note says why", async () => {
    const ctx = await prepared();
    const verify = async (_s: unknown, f: ReadonlyMap<string, string>) =>
      f.has("ui/sections/home-hero.tsx")
        ? { ok: false, problems: ["G0-TS-01: ошибка типов в ui/sections/home-hero.tsx"] }
        : { ok: true, problems: [] };
    const m = model({ hero: [HERO_CODE.source], "first-visit": [SIGNATURE_OK.source] });
    const r = await composer({ verify }).scenario({ ...ctx, route: m.route }, LEAD);
    expect(r.files.has("ui/sections/home-hero.tsx")).toBe(false);
    expect(r.notes.join(" ")).toContain(
      "не прошёл проверки (G0-TS-01: ошибка типов в ui/sections/home-hero.tsx)",
    );
  });

  test("a link to an anchor the page lacks is a hard issue at its section; existing ids and other pages pass", () => {
    const code = (id: string, source: string, props: Record<string, unknown> = {}) =>
      ({ kind: "code", id, title: id, source, props }) as const;
    const answer = (src: string, props?: Record<string, unknown>) =>
      ({
        seo: { title: "t", description: "d" },
        sections: [
          code("hero", src, props),
          code("steps", '<section id="how">шаги</section>'),
          { kind: "keep", id: "form" },
        ],
      }) as never;
    const home = { route: "/", sections: [{ id: "header" }, { id: "form" }, { id: "footer" }] } as never;
    expect(anchorIssues(answer('<a href="#order">Заказать</a>'), home)).toEqual([
      expect.objectContaining({
        path: "sections.0.source",
        code: "BROKEN_ANCHOR",
        message: expect.stringContaining("#order"),
      }),
    ]);
    expect(
      anchorIssues(answer("<a href={props.cta.href}>x</a>", { cta: { href: "/#order" } }), home),
    ).toHaveLength(1);
    expect(
      anchorIssues(answer('<a href="#form">x</a><a href="#how">y</a><a href="#steps">z</a>'), home),
    ).toEqual([]);
    const inner = { route: "/services", sections: [{ id: "form" }] } as never;
    expect(anchorIssues(answer('<a href="/#order">x</a>'), inner)).toEqual([]);
  });

  test("a link to an absent anchor is sent by code to /booking, else to the page's form; present ones stay", () => {
    const answer = (src: string) =>
      ({
        seo: { title: "t", description: "d" },
        sections: [
          { kind: "code", id: "hero", title: "hero", source: src, props: {} },
          { kind: "keep", id: "contacts" },
        ],
      }) as never;
    const page = { route: "/services", sections: [{ id: "header" }, { id: "footer" }] } as never;
    const src = '<a href="#request">Заявка</a><a href="#contacts">Контакты</a>';
    expect(retargetAnchors(answer(src), page, ["/", "/services", "/booking"]).get("hero")).toBe(
      '<a href="/booking">Заявка</a><a href="#contacts">Контакты</a>',
    );
    expect(retargetAnchors(answer(src), page, ["/", "/services"]).get("hero")).toBe(
      '<a href="#contacts">Заявка</a><a href="#contacts">Контакты</a>',
    );
    expect(retargetAnchors(answer('<a href="#contacts">x</a>'), page, ["/booking"]).size).toBe(0);
    const fixed = answer(retargetAnchors(answer(src), page, ["/booking"]).get("hero") ?? "");
    expect(anchorIssues(fixed, page)).toEqual([]);
  });

  test("mechanical slips are fixed by code, not by a call", () => {
    const slip = HERO_CODE.source
      .replace("export default function Hero", "export function Hero")
      .replace('className="min-w-0"', 'class="min-w-0"');
    const fixed = autofixSection(`\`\`\`tsx\n${slip}\`\`\``);
    expect(fixed).toContain("export default function Hero");
    expect(fixed).toContain('className="min-w-0"');
    expect(sectionIssues(fixed, { id: "hero", hero: true })).toEqual([]);
    expect(autofixSection('import { motion } from "framer-motion";')).toBe(
      'import { motion } from "motion/react";',
    );
    expect(sectionIssues(SIGNATURE_OK.source, { id: "x", hero: true }).map((i) => i.code)).toContain("NO_H1");
  });

  test("m.* without LazyMotion gets the wrapper and the import; a half fence is dropped", () => {
    const src = [
      'import { m, useReducedMotion } from "motion/react";',
      "",
      "export default function Hero({ title }: { title: string }) {",
      "  const reduce = useReducedMotion();",
      "  return (",
      '    <section className="bg-background px-gutter py-section text-foreground">',
      '      <m.h1 initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} className="font-display text-hero">',
      "        {title}",
      "      </m.h1>",
      "    </section>",
      "  );",
      "}",
      "",
    ].join("\n");
    const fixed = autofixSection(`tsx\n${src}`);
    expect(fixed.startsWith("tsx")).toBe(false);
    expect(fixed).toContain("<LazyMotion features={domAnimation}>");
    expect(fixed).toMatch(/import \{[^}]*LazyMotion[^}]*\} from "motion\/react"/);
    expect(sectionIssues(fixed, { id: "hero", hero: true }).map((i) => i.code)).not.toContain("MOTION_LAZY");
  });

  test("bare return with m.*, a link without colour, two arguments of fitWords — fixed by code", () => {
    const src = [
      'import { m } from "motion/react";',
      'import { fitWords } from "@wizard/ui-kit/v3/headless";',
      "",
      "export default function Hero({ title }: { title: string }) {",
      "  const fit = fitWords(title, 3);",
      '  return <section className="bg-background px-gutter py-section text-foreground">',
      '      <m.h1 animate={{ opacity: 1 }} className="font-display text-hero">{fit.chars}{title}</m.h1>',
      '      <a href="tel:+70000000000" className="font-medium underline">Позвонить</a>',
      "    </section>;",
      "}",
      "",
    ].join("\n");
    const fixed = autofixSection(src);
    expect(fixed).toContain("fitWords(title)");
    expect(fixed).toContain(
      'className="inline-flex items-center text-inherit font-medium underline min-h-11"',
    );
    expect(fixed).toContain("<LazyMotion features={domAnimation}>");
    const codes = sectionIssues(fixed, { id: "hero", hero: true }).map((i) => i.code);
    expect(codes).not.toContain("MOTION_LAZY");
    expect(codes).not.toContain("LINK_COLOR");
  });

  test("LazyMotion imported but not rendered gets the wrapper; href={safeHref(x)} takes its href", () => {
    const src = [
      'import { LazyMotion, domAnimation, m } from "motion/react";',
      'import { safeHref } from "@wizard/ui-kit/v3/headless";',
      "",
      "export default function Cta({ title, href }: { title: string; href: string }) {",
      "  return (",
      '    <section className="bg-background px-gutter py-section text-foreground">',
      '      <m.h2 animate={{ opacity: 1 }} className="font-display text-h2">{title}</m.h2>',
      '      <a href={safeHref(href)} className="text-primary">Записаться</a>',
      "    </section>",
      "  );",
      "}",
      "",
    ].join("\n");
    const fixed = autofixSection(src);
    expect(fixed).toContain("<LazyMotion features={domAnimation}>");
    expect(fixed).toContain("href={safeHref(href)?.href}");
    expect(sectionIssues(fixed, { id: "cta", hero: false }).map((i) => i.code)).not.toContain("MOTION_LAZY");
  });

  test("motion without reduced motion gets MotionConfig; a phone link gets a finger's height and no letter spacing", () => {
    const src = [
      'import { domAnimation, LazyMotion, m } from "motion/react";',
      "export default function Contacts() {",
      "  return (",
      "    <LazyMotion features={domAnimation}>",
      '      <section className="bg-background px-gutter py-section text-foreground">',
      '        <m.h2 animate={{ opacity: 1 }} className="font-display text-h2">Контакты</m.h2>',
      '        <a href="tel:+73432003040" className="text-primary font-display text-h3 tracking-widest">+7 343 200-30-40</a>',
      "      </section>",
      "    </LazyMotion>",
      "  );",
      "}",
      "",
    ].join("\n");
    const fixed = autofixSection(src);
    expect(fixed).toContain('<MotionConfig reducedMotion="user">');
    expect(fixed).toMatch(/import \{[^}]*MotionConfig[^}]*\} from "motion\/react"/);
    expect(fixed).toContain(
      'className="inline-flex items-center text-primary font-display text-h3 min-h-11"',
    );
    const codes = sectionIssues(fixed, { id: "contacts", hero: false }).map((i) => i.code);
    expect(codes).not.toContain("REDUCED_MOTION");
    expect(codes).not.toContain("MOTION_LAZY");
    // A link already tall enough keeps its classes.
    const tall = '<a href="tel:+7" className="inline-flex min-h-12 items-center text-primary">x</a>';
    expect(autofixSection(tall)).toBe(tall);
  });

  test("motion names used but not imported join the import: <m.x> inside its own LazyMotion (DeepSeek)", () => {
    const src = [
      'import { LazyMotion, domAnimation, motion, useReducedMotion } from "motion/react";',
      "export default function Steps() {",
      "  const reduce = useReducedMotion();",
      "  return (",
      "    <LazyMotion features={domAnimation}>",
      '      <m.h2 className="font-display text-h2">Как проходит запись</m.h2>',
      "    </LazyMotion>",
      "  );",
      "}",
      "",
    ].join("\n");
    const fixed = withMotionImports(src);
    expect(fixed).toMatch(/import \{[^}]*\bm\b[^}]*\} from "motion\/react"/);
    expect(fixed.match(/from "motion\/react"/g)).toHaveLength(1);
    const ok = 'import { m } from "motion/react";\nconst X = () => <m.div />;';
    expect(withMotionImports(ok)).toBe(ok);
    expect(withMotionImports("const X = () => <m.div />;")).toBe(
      'import { m } from "motion/react";\nconst X = () => <m.div />;',
    );
  });

  test("an entrance starts visible: opacity 0 leaves initial and hidden, the shift stays", () => {
    const fixed = autofixSection(
      [
        "const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };",
        "<m.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} />",
        "<m.p initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} />",
        "<m.p initial={{ opacity: 0.5 }} />",
      ].join("\n"),
    );
    expect(fixed).toContain("hidden: { y: 12 }, show: { opacity: 1, y: 0 }");
    expect(fixed).toContain("initial={{ y: 16 }} whileInView={{ opacity: 1, y: 0 }}");
    expect(fixed).toContain("initial={reduce ? false : {}}");
    expect(fixed).toContain("initial={{ opacity: 0.5 }}");
  });

  test("the plan: sections as a JSON string are parsed, «01» ordinals leave props", () => {
    const plan = normalizePlan({
      sections: JSON.stringify([
        {
          kind: "code",
          id: "steps",
          title: "Как записаться",
          props: { items: [{ n: "01", title: "Звонок" }, "02"] },
        },
      ]),
      seo: { title: "t", description: "d" },
    }) as { sections: { props: unknown }[] };
    expect(plan.sections[0]?.props).toEqual({ items: [{ title: "Звонок" }] });
  });

  test("a kept component's binding comes from the page, whatever the plan wrote", async () => {
    const ctx = await prepared();
    const plan: PagePlan = {
      ...PLAN,
      sections: PLAN.sections.map((x) =>
        x.kind === "keep" && x.id === "form"
          ? { ...x, props: { title: "Запишитесь", fields: ["phone"] } }
          : x,
      ),
    };
    const m = model({ hero: [HERO_CODE.source], "first-visit": [SIGNATURE_OK.source] });
    const route: typeof m.route = async (input) =>
      input.tools?.[0]?.name === PAGE_PLAN_TOOL ? out(PAGE_PLAN_TOOL, plan, 1) : m.route(input);
    const r = await composer().scenario({ ...ctx, route }, LEAD);
    const home = (readSite(apply(ctx.files, r)) as SiteModel).pages[0];
    const form = home?.sections.find((x) => x.id === "form");
    const before = (readSite(ctx.files) as SiteModel).pages[0]?.sections.find((x) => x.id === "form");
    expect(form?.props.fields).toEqual(before?.props.fields);
    expect(form?.props.title).toBe("Запишитесь");
  });

  test("an import headless does not have for a section is dropped with its block; the prompt lists what it has", () => {
    const src = HERO_CODE.source
      .replace(
        "export default function",
        'import { Accordion, srcSetOf } from "@wizard/ui-kit/v3/headless";\n\nexport default function',
      )
      .replace("</h1>", "</h1>\n          <Accordion items={[]} />");
    expect(sectionIssues(src, { id: "hero", hero: true }).map((i) => i.code)).toContain("UNKNOWN_IMPORT");
    const fixed = autofixSection(src);
    expect(fixed).not.toContain("Accordion");
    expect(fixed).toContain('import { srcSetOf } from "@wizard/ui-kit/v3/headless";');
    expect(sectionIssues(fixed, { id: "hero", hero: true }).map((i) => i.code)).not.toContain(
      "UNKNOWN_IMPORT",
    );
  });
});
