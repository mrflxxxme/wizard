// V3-18: every form variant of the pattern library under the modules' goal programs — the skeleton composes a site
// with the library narrowed to one request form variant (the interior studio, v3-01: GS-landing-1, GS-leads-1,
// GS-catalog-4) or one booking variant (the dental clinic, v3-02, with a request form too: GS-booking-1, GS-booking-2
// and GS-catalog-4, whose items lead to the booking), and the platform's checkScenario runs them in Chromium. The forms
// differ in what the programs must drive: one column or two, a form in steps («Далее» before the contacts), the service
// as cards, a list or radio cards, the days as a strip or a list, a booking in steps. A variant the skeleton does not
// take by itself (the form on a photo needs one) is put in its place the way a model's page does. The seed picks the
// other sections; the eval briefs as the harness builds them — v3-goals.browser.test.ts.
import {
  briefNiche,
  briefPlan,
  compileBackend,
  createPageComposer,
  readSite,
  type SiteModel,
  withSitePages,
} from "@wizard/agents/builder";
import { DEFAULT_REGISTRY } from "@wizard/agents/planner";
import { type AppSpec, type BriefScenario, type SystemBriefInput, systemBriefSchema } from "@wizard/appspec";
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import { PATTERNS, type PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { siteFiles } from "../../../packages/agents/src/builder/v3/compose/codegen.js";
import { DENTAL_BOOKING, INTERIOR_STUDIO } from "../../../packages/agents/test/v3-eval-briefs.js";
import { type Draft, type GoalsEnv, goalsEnv, hasChromium, OWNER_COMPLIANCE } from "./v3-goals-helpers.js";

let env: GoalsEnv;
beforeAll(async () => {
  if (hasChromium) env = await goalsEnv("v3vars");
}, 60_000);
afterAll(async () => {
  await env?.close();
});

/** The library with one variant of the form of a need: the composer can only take it. */
const only = (v: PatternMeta) =>
  PATTERNS.filter((p) => !(p.sectionType === "form" && p.needs === v.needs) || p.id === v.id);

/**
 * The site of a brief composed on a library (the skeleton, no model); when the skeleton did not take `v` (its slots
 * ask for content the skeleton does not give, a photo), the form of its need takes it with the example's content.
 */
async function composed(id: string, input: SystemBriefInput, v: PatternMeta) {
  const brief = systemBriefSchema.parse(input);
  const systemId = `sys-${id}`;
  const bp = briefPlan(brief, DEFAULT_REGISTRY, [], { appName: "Проверка" });
  if (!bp) throw new Error(`${id}: no plan`);
  const design = designSystemV3({
    archetype: brief.design.archetype as never,
    seed: systemId,
    niche: briefNiche(brief),
  });
  const backend = compileBackend({
    plan: bp.plan,
    registry: DEFAULT_REGISTRY,
    extensions: [],
    design,
    options: { appName: "Проверка" },
  });
  if (!backend.ok) throw new Error(backend.message_ru);
  const spec = {
    ...backend.spec,
    compliance: { ...backend.spec.compliance, ...OWNER_COMPLIANCE },
  } as AppSpec;
  const skeleton = async (library: readonly PatternMeta[]) => {
    const files = new Map(Object.entries(backend.files));
    const out = await createPageComposer({ patterns: library }).skeleton({
      systemId,
      brief,
      briefVersion: 1,
      plan: backend.plan,
      spec,
      publicFront: backend.publicFront,
      design,
      files,
      route: async () => {
        throw new Error("0 ₽: no model");
      },
      budgetRub: 0,
    });
    for (const [p, f] of out.files) f === null ? files.delete(p) : files.set(p, f);
    return { files, site: readSite(files) as SiteModel };
  };
  let { files, site } = await skeleton(only(v));
  const bound = (needs: PatternMeta["needs"]) =>
    site.pages.flatMap((p) =>
      p.sections.filter(
        (s) => s.type === "form" && PATTERNS.find((x) => x.id === s.pattern)?.needs === needs,
      ),
    );
  if (!bound(v.needs).some((s) => s.pattern === v.id)) {
    // The skeleton leaves the form out without the variant's content: the whole library, then the variant in place.
    ({ files, site } = await skeleton(PATTERNS));
    const example = v.example as Record<string, unknown>;
    site = {
      ...site,
      pages: site.pages.map((p) => ({
        ...p,
        sections: p.sections.map((s) =>
          s.type === "form" && PATTERNS.find((x) => x.id === s.pattern)?.needs === v.needs
            ? {
                ...s,
                pattern: v.id,
                props: v.slots.parse({ ...s.props, image: example.image }) as Record<string, unknown>,
              }
            : s,
        ),
      })),
    };
    for (const [p, f] of siteFiles(site, "Проверка", design, files))
      f === null ? files.delete(p) : files.set(p, f);
    site = readSite(files) as SiteModel;
  }
  const draft: Draft = { version: 1, spec: withSitePages(spec, site), files: Object.fromEntries(files) };
  return { draft, forms: bound(v.needs), scenarios: backend.scenarios, brief };
}

/** The dental clinic with a request form too: GS-catalog-4 runs, and the catalog items lead to the booking. */
const DENTAL_WITH_LEADS: SystemBriefInput = {
  ...DENTAL_BOOKING,
  scenarios: [
    ...(DENTAL_BOOKING.scenarios ?? []),
    {
      id: "s_question",
      actor: "visitor",
      when: "пациент хочет задать вопрос до записи",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["принимает заявку с телефоном"],
      moduleHint: "leads",
    },
  ],
};

const CASES: { need: "lead" | "booking"; brief: SystemBriefInput; id: string; goals: string[] }[] = [
  {
    need: "lead",
    brief: INTERIOR_STUDIO,
    id: "v3-01-interior-studio",
    goals: ["GS-landing-1", "GS-leads-1", "GS-catalog-4"],
  },
  {
    need: "booking",
    brief: DENTAL_WITH_LEADS,
    id: "v3-02-dental-booking",
    goals: ["GS-booking-1", "GS-booking-2", "GS-catalog-4"],
  },
];

describe.skipIf(!hasChromium)("every form variant of the library under the goal programs in Chromium", () => {
  for (const c of CASES)
    for (const v of PATTERNS.filter((p) => p.sectionType === "form" && p.needs === c.need))
      test(`${v.id} (${c.id})`, async () => {
        const { draft, forms, scenarios, brief } = await composed(c.id, c.brief, v);
        // The site's form of this need is this variant.
        expect(forms.map((s) => s.pattern)).toEqual([v.id]);
        const goals = scenarios.filter((s) => c.goals.includes(s.id));
        expect(goals.map((s) => s.id).sort()).toEqual([...c.goals].sort());
        const r = await env.check(draft, {
          scenario: brief.scenarios[0] as BriefScenario,
          goalScenarios: goals,
          routes: [],
          revision: draft.version,
        });
        expect(r.problems).toEqual([]);
        expect(r.ok).toBe(true);
      }, 600_000);
});
