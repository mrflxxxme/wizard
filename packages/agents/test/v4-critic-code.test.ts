// V4-09 acceptance (node part): the critic of another family edits the page's code. A section the page model wrote as
// code (SitePage.author = kimi-k3) gets new TSX through rewrite_code: the pattern rules refuse what breaks the theme,
// G0 rolls a broken rewrite back, and every critic call avoids the author's family. ≤ 2 cycles is in v3-critic.test.ts.
import { modelFamilyOf } from "@wizard/llm";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { applyEdit, type CriticState, type EditEnv, runCritic } from "../src/builder/index.js";
import { siteFacts, siteFiles } from "../src/builder/v3/compose/index.js";
import type { SiteModel } from "../src/builder/v3/compose/site.js";
import { HERO_CODE } from "./v3-compose-fixtures.js";
import {
  criticContext,
  critique,
  critiqueLines,
  fakeInspector,
  firstPrompt,
  fixtureRoute,
  registry,
} from "./v3-critic-fixtures.js";

const base = await criticContext();
const FILE = "ui/sections/home-path.tsx";
const AUTHOR = "kimi-k3";
const section = {
  id: "path",
  type: "signature" as const,
  pattern: "signature",
  props: HERO_CODE.props,
  file: FILE,
  title: "Путь пациента",
};
const site: SiteModel = {
  ...base.site,
  pages: base.site.pages.map((p) =>
    p.route === "/"
      ? {
          ...p,
          author: AUTHOR,
          sections: p.sections.flatMap((x) => (x.id === "services" ? [x, section] : [x])),
        }
      : p,
  ),
};
const code = new Map([[FILE, HERO_CODE.source]]);
const files = new Map(base.files);
files.set(FILE, HERO_CODE.source);
for (const [k, v] of siteFiles(site, siteFacts(base).copy.site, base.design, files, code))
  v === null ? files.delete(k) : files.set(k, v);
const ctx = { ...base, files, site };
const env: EditEnv = { library: PATTERNS, numbers: siteFacts(ctx).numbers };
const state: CriticState = { site, design: ctx.design, code };

const NEW_SOURCE = HERO_CODE.source.replace(
  "md:grid-cols-[1.2fr_1fr] md:items-end",
  "md:grid-cols-[1fr_1.4fr] md:items-center",
);
const rewrite = (source: string) => ({
  sign: "путь пациента повторяет раскладку первого экрана",
  where: "/@1440#path",
  severity: "P1",
  evidence: "изображение 3, 1500–2100 px",
  replace: "фото крупнее, текст по центру",
  edit: { op: "rewrite_code", route: "/", section: "path", source },
});

describe("V4-09 critic edits the code of the page", () => {
  test("rewrite_code: a code section gets the new TSX; theme breakers and pattern sections are refused", () => {
    const ok = applyEdit(state, { op: "rewrite_code", route: "/", section: "path", source: NEW_SOURCE }, env);
    expect(ok.ok && ok.state.code?.get(FILE)).toBe(NEW_SOURCE);
    expect(ok.ok && ok.summary_ru).toBe("/#path: код секции переписан");
    const imported = applyEdit(
      state,
      { op: "rewrite_code", route: "/", section: "path", source: `import x from "y";\n${NEW_SOURCE}` },
      env,
    );
    expect(imported.ok).toBe(false);
    const pattern = applyEdit(
      state,
      { op: "rewrite_code", route: "/", section: "hero", source: NEW_SOURCE },
      env,
    );
    expect(pattern.ok).toBe(false);
    expect(!pattern.ok && pattern.reason_ru).toContain("только секции, написанные кодом");
  });

  test("the critic's rewrite lands in the file; every call avoids the author's family", async () => {
    const fx = fixtureRoute(critiqueLines(firstPrompt(ctx, code), [critique(2, [rewrite(NEW_SOURCE)])]));
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([]), verify: null, registry, maxCycles: 1 },
    );
    expect(r.cycles[0]?.applied).toEqual(["/#path: код секции переписан"]);
    expect(r.files.get(FILE)).toBe(NEW_SOURCE);
    expect(fx.calls.length).toBeGreaterThan(0);
    for (const c of fx.calls) expect(c.avoidFamilies).toContain(modelFamilyOf(registry, AUTHOR));
  });

  test("a rewrite that breaks the build (G0) is rolled back: the file keeps the author's code", async () => {
    const broken = NEW_SOURCE.replace("{lead}", "{lead}{missing}");
    const fx = fixtureRoute(critiqueLines(firstPrompt(ctx, code), [critique(2, [rewrite(broken)])]));
    const verify = async (_spec: unknown, f: ReadonlyMap<string, string>) =>
      f.get(FILE)?.includes("{missing}")
        ? { ok: false, problems: [`G0-TS-01: ошибка типов в ${FILE}`] }
        : { ok: true, problems: [] };
    const r = await runCritic(
      { ...ctx, route: fx.route },
      { inspect: fakeInspector([]), verify, registry, maxCycles: 1 },
    );
    expect(r.cycles[0]?.applied).toEqual([]);
    expect(r.cycles[0]?.rejected[0]?.reason_ru).toContain("откат: сборка: G0-TS-01");
    expect(r.files.has(FILE) ? r.files.get(FILE) : HERO_CODE.source).toBe(HERO_CODE.source);
  });
});
