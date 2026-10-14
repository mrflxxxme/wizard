// V4-09 critic v4 (node part): a finding may carry a code edit of a page file (patch {file, find, replace}) instead of a
// closed operation; the deterministic checks — the edit's own (it parses, keeps imports and data bindings, no raw
// colours or fonts, its fragment is in the file exactly once, never the pattern library), G0 and the browser checks —
// accept it or roll it back, never the model's score; the critic is never of the pages' author's family; ≤ 2 cycles.
import type { RouteInput } from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { siteFacts } from "../src/builder/v3/compose/index.js";
import {
  defaultAuthorFamilies,
  editPatches,
  runCritic,
  shotPlan,
  withCode,
} from "../src/builder/v3/critic/hook.js";
import { critiqueMessages } from "../src/builder/v3/critic/prompt.js";
import {
  criticContext,
  critique,
  critiqueLines,
  fakeInspector,
  fakeShots,
  firstPrompt,
  fixtureRoute,
  type InspectRule,
  registry,
} from "./v3-critic-fixtures.js";

const ctx = await criticContext();
const prompt = firstPrompt(ctx);
const homeFile = ctx.site.pages.find((p) => p.route === "/")?.file as string;
const homeSrc = ctx.files.get(homeFile) as string;
const title = ctx.site.pages.find((p) => p.route === "/")?.sections.find((s) => s.id === "hero")?.props as
  | { title?: string }
  | undefined;

const finding = (patch: unknown, severity = "P1") => ({
  sign: "заголовок первого экрана теряется",
  where: "/@390#hero",
  severity,
  evidence: "изображение 1, первый экран",
  replace: "заголовок короче и крупнее",
  edit: null,
  patch,
});
/** The browser checks flag the hero when the home file has `marker`. */
const whenHomeHas =
  (marker: string): InspectRule =>
  ({ files }, route) =>
    route === "/" && files.get(homeFile)?.includes(marker)
      ? [{ code: "L11", section: "hero", message_ru: "переполнение первого экрана" }]
      : [];

describe("V4-09: code edits of the critic", () => {
  test("the prompt shows the code of the shown page; withCode applies a unique fragment and skips a missing one", () => {
    const shots = fakeShots({ shots: shotPlan(ctx.site) });
    const m = critiqueMessages({
      facts: siteFacts(ctx),
      brief: ctx.brief,
      site: ctx.site,
      design: ctx.design,
      library: PATTERNS,
      shots,
      found: [],
      history: [],
      code: new Map([[homeFile, homeSrc]]),
    });
    expect(String(m[1]?.content)).toContain(`Код ${homeFile}:`);
    expect(String(m[0]?.content)).toContain("patch {file, find, replace}");
    const layer = withCode(new Map(), ctx.files, [
      { file: homeFile, find: "export default function", replace: "export default function /*x*/" },
      { file: homeFile, find: "нет такого фрагмента", replace: "y" },
    ]);
    expect(layer.get(homeFile)).toContain("/*x*/");
  });

  test("a code edit the checks accept stays; one the browser checks flag is rolled back; bad ones are refused", async () => {
    const t = title?.title as string;
    expect(homeSrc).toContain(t);
    const good = { file: homeFile, find: JSON.stringify(t), replace: JSON.stringify("Лечим зубы без боли") };
    const broken = {
      file: homeFile,
      find: "export default function",
      replace: "/* BROKEN_MARK */\nexport default function",
    };
    const raw = {
      file: homeFile,
      find: "export default function",
      replace: 'const accent = "#ff0000";\nexport default function',
    };
    const library = { file: "ui/patterns/hero-split.tsx", find: "export", replace: "export " };
    const absent = { file: homeFile, find: "такого фрагмента в файле нет", replace: "x" };
    const fx = fixtureRoute(
      critiqueLines(prompt, [
        critique(2, [finding(good), finding(raw, "P2"), finding(library, "P2"), finding(absent, "P3")]),
      ]),
    );
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([whenHomeHas("BROKEN_MARK")]), verify: null, registry, maxCycles: 1 },
    );
    const applied = r.cycles[0]?.applied ?? [];
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain("правка кода");
    expect(r.files.get(homeFile)).toContain("Лечим зубы без боли");
    const reasons = (r.cycles[0]?.rejected ?? []).map((x) => x.reason_ru).join(" | ");
    expect(reasons).toMatch(/сырые цвета/);
    expect(reasons).toMatch(/библиотеку секций не правим/);
    expect(reasons).toMatch(/ровно один раз/);

    // A code edit the browser checks flag: rolled back, the file stays as it was.
    const fx2 = fixtureRoute(critiqueLines(prompt, [critique(2, [finding(broken)])]));
    const r2 = await runCritic(
      { ...ctx, route: fx2.route },
      { inspect: fakeInspector([whenHomeHas("BROKEN_MARK")]), verify: null, registry, maxCycles: 1 },
    );
    expect(r2.cycles[0]?.applied).toEqual([]);
    expect(r2.rolledBack.join(" ")).toContain("правка кода");
    expect(r2.files.get(homeFile) ?? "").not.toContain("BROKEN_MARK");
  });

  test("qwen's patch in `edit` ({op: patch, file, find, replace}) is the finding's patch: applied, not «без правки»", async () => {
    const t = title?.title as string;
    const good = { file: homeFile, find: JSON.stringify(t), replace: JSON.stringify("Лечим зубы без боли") };
    // As recorded by the probe critic_cycle (14.10.2026): the patch in `edit`, `patch` null.
    const inEdit = { ...finding(null), edit: { op: "patch", ...good } };
    expect(editPatches({ findings: JSON.stringify([inEdit]) })).toEqual({
      findings: [{ ...inEdit, edit: null, patch: good }],
    });
    // A closed edit and a finding with its own patch stay as they are.
    const op = { ...finding(null), edit: { op: "token", token: "display_size", value: "smaller" } };
    expect(editPatches({ findings: [op, finding(good)] })).toEqual({ findings: [op, finding(good)] });
    const fx = fixtureRoute(critiqueLines(prompt, [critique(2, [inEdit])]));
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([]), verify: null, registry, maxCycles: 1 },
    );
    expect(r.cycles[0]?.noEdit).toBeUndefined();
    expect(r.cycles[0]?.applied).toEqual([expect.stringContaining("правка кода")]);
    expect(r.files.get(homeFile)).toContain("Лечим зубы без боли");
  });

  test("rehearsal №6: on a short home page a dropped block is refused, its reason in the cycle's rejected", async () => {
    const drop = {
      ...finding(null, "P2"),
      sign: "лишний блок",
      edit: { op: "drop_section", route: "/", section: "services" },
    };
    const fx = fixtureRoute(critiqueLines(prompt, [critique(2, [drop])]));
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([]), verify: null, registry, maxCycles: 1 },
    );
    expect(r.cycles[0]?.applied).toEqual([]);
    expect(r.cycles[0]?.rejected).toEqual([
      {
        edit: expect.stringContaining("services"),
        reason_ru: expect.stringContaining("на главной останется меньше"),
      },
    ]);
    expect(r.files.get(homeFile) ?? homeSrc).toContain("services");
  });

  test("the critic is never of the pages' author's family: the route gets avoidFamilies", async () => {
    const seen: RouteInput[] = [];
    const fx = fixtureRoute(critiqueLines(prompt, [critique(4, [], "production")]));
    const r = await runCritic(
      {
        ...ctx,
        route: async (i) => {
          seen.push(i as RouteInput);
          return fx.route(i);
        },
      },
      { inspect: fakeInspector([]), verify: null, registry, authorFamilies: async () => ["glm"] },
    );
    expect(r.stop).toBe("pass");
    const avoid = seen[0]?.avoidFamilies ?? [];
    expect(avoid).toContain("glm");
    for (const f of defaultAuthorFamilies(registry)) expect(avoid).toContain(f);
  });
});
