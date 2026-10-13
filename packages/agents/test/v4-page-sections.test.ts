// V4-06 speed: the page by sections — a short plan call, then one call per code section at once; the page assembled
// by code and checked as before, only a failing section written again; mechanical slips fixed by code (no call).
import type { BriefScenario } from "@wizard/appspec";
import { createRegistry, type RouteInput, type RouteOutput } from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { createPageComposer, readSite, type SiteModel } from "../src/builder/v3/compose/index.js";
import {
  autofixSection,
  PAGE_PLAN_TOOL,
  type PagePlan,
  SECTION_CODE_TOOL,
  sectionIssues,
} from "../src/builder/v3/compose/page-sections.js";
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
