// M2-38: the orchestrator is not tied to the golden demo — neutral platform text, class recipes site/booking/crm (D66:
// recipes, not a menu), shared text rules (D48, D49) and fork selection per class (orchestrator.yaml#fork_taxonomy.rules).
import { describe, expect, test } from "vitest";
import {
  type Analysis,
  analysisSchema,
  askQuestionsSchema,
  checkQuestions,
  FORK_IDS,
  FORKS,
  forkOptions,
  getFork,
  SEGMENTS,
  selectForks,
  staticPrompt,
} from "../../src/orchestrator/index.js";
import { textRules } from "../../src/text-rules.js";

const analysis = (a: Partial<Analysis> & Pick<Analysis, "segment" | "roles" | "entities">): Analysis =>
  analysisSchema.parse({
    goals: ["Система под задачу"],
    skeleton: ["application", "process"],
    integrations: [],
    constraints: [],
    resolved: [],
    unknowns: [],
    outOfScope: [],
    complexity: "small",
    ...a,
  });

const role = (name: string, isStaff: boolean, access: "public" | "login" = "login") => ({
  name,
  label: name,
  access,
  isStaff,
  evidence: "",
});
const entity = (name: string, containsPii = false) => ({ name, label: name, keyFields: [], containsPii });

/** One synthetic brief analysis per release class. */
const CLASS_ANALYSES: Record<"site" | "booking" | "crm", Analysis> = {
  site: analysis({
    segment: "site",
    goals: ["Лендинг студии ремонта с формой заявки"],
    roles: [role("owner", true), role("visitor", false, "public")],
    entities: [entity("lead", true)],
  }),
  booking: analysis({
    segment: "booking",
    goals: ["Запись клиентов на услуги к мастерам"],
    roles: [role("owner", true), role("master", true), role("client", false, "public")],
    entities: [entity("service"), entity("booking", true)],
  }),
  crm: analysis({
    segment: "crm",
    goals: ["Учёт клиентов и сделок отдела продаж"],
    skeleton: ["process"],
    roles: [role("head", true), role("manager", true)],
    entities: [entity("client", true), entity("deal")],
  }),
};

describe("static prompt", () => {
  const prompt = staticPrompt();

  test("no golden scenario: no skeleton «Каталог → Заявка», no forum, tickets or confectionery", () => {
    const low = prompt.toLowerCase();
    for (const w of ["каталог → заявка", "форум", "билет", "кондитер", "торт"]) expect(low).not.toContain(w);
  });

  test("text rules come from the shared module, not a copy; recipes and honest limits are there", () => {
    for (const r of textRules("chat")) expect(prompt).toContain(r);
    for (const s of ["site", "booking", "crm"]) expect(prompt).toContain(`- ${s}:`);
    expect(prompt).toContain("segment=other");
    expect(prompt).toContain("report_capability_gap");
    expect(prompt).toContain("Пока не умеем");
  });

  test("budget: static ≤ 6k tokens (≈ 3.2 characters per token)", () => {
    expect(prompt.length / 3.2).toBeLessThanOrEqual(6000);
  });
});

describe("segments are recipes", () => {
  test("site, booking, crm and other are segments; events and made_to_order stay", () => {
    for (const s of ["site", "booking", "crm", "other", "events", "made_to_order", "horizontal"])
      expect(SEGMENTS).toContain(s);
  });

  test.each(Object.entries(CLASS_ANALYSES))(
    "%s: 3–7 questions, ≥ 2 forks of its class and horizontal ones, all from the taxonomy",
    (segment, a) => {
      const sel = selectForks(a);
      expect(sel.asked.length).toBeGreaterThanOrEqual(3);
      expect(sel.asked.length).toBeLessThanOrEqual(7);
      const groups = sel.asked.map((x) => getFork(x.forkId)?.group);
      expect(groups.filter((g) => g === segment).length).toBeGreaterThanOrEqual(2);
      expect(groups).toContain("horizontal");
      for (const x of [...sel.asked, ...sel.decided]) expect(FORK_IDS).toContain(x.forkId);
      // Recipes of other classes never leak in.
      const others = new Set(FORKS.map((f) => f.group).filter((g) => g !== segment && g !== "horizontal"));
      for (const x of [...sel.asked, ...sel.decided])
        expect(others.has(getFork(x.forkId)?.group as never)).toBe(false);
    },
  );

  test.each(Object.entries(CLASS_ANALYSES))(
    "%s: questions from the taxonomy pass checkQuestions on the free plan — exactly one recommended, no phone login",
    (_segment, a) => {
      const sel = selectForks(a);
      const questions = sel.asked.map((x, i) => {
        const f = getFork(x.forkId);
        if (!f) throw new Error(x.forkId);
        const options = forkOptions(x.forkId, { plan: "free" }).slice(0, 4);
        const rec = f.recommend(a, new Map());
        const recId = options.includes(rec) ? rec : options[0];
        return {
          id: `q${i + 1}`,
          forkId: x.forkId,
          text: f.q,
          whyItMatters: "От ответа зависит, как будет устроена система.",
          options: options.map((o) => ({ id: o, label: o, recommended: o === recId })),
          allowCustom: true,
        };
      });
      const parsed = askQuestionsSchema.parse({ questions });
      expect(
        checkQuestions(
          parsed.questions,
          sel.asked.map((x) => x.forkId),
          { plan: "free" },
        ),
      ).toEqual([]);
      for (const q of parsed.questions) {
        expect(q.options.filter((o) => o.recommended)).toHaveLength(1);
        expect(q.options.map((o) => o.id).filter((o) => o.startsWith("phone"))).toEqual([]);
      }
    },
  );

  test("other: only horizontal forks, the general pipeline", () => {
    const a = { ...CLASS_ANALYSES.booking, segment: "other" as const };
    const sel = selectForks(a);
    for (const x of [...sel.asked, ...sel.decided]) expect(getFork(x.forkId)?.group).toBe("horizontal");
    // Booking signals still matter without the recipe: F-BOOKING applies by the brief text only.
    expect(sel.asked.length).toBeGreaterThan(0);
  });

  test("crm: the path of a deal is asked once (F-CRM-PIPELINE), not twice with F-STATUSES", () => {
    const sel = selectForks(CLASS_ANALYSES.crm);
    const ids = [...sel.asked, ...sel.decided].map((x) => x.forkId);
    expect(ids).toContain("F-CRM-PIPELINE");
    expect(ids).not.toContain("F-STATUSES");
  });
});
