// V4-18 in the critic of V4-09: the stub codes S01–S04 are deterministic checks of the critic (rubric, penalty), the
// owner's contacts reach the inspector, and a code edit that adds a stub — a placeholder text, a dead link, a contact
// the owner did not give — is refused before the browser; an edit that adds none passes.
import { STUB_CODES } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import { newStub, runCritic } from "../src/builder/v3/critic/hook.js";
import { CHECK_CODES, CHECK_RUBRIC, problemPenalty } from "../src/builder/v3/critic/rubric.js";
import type { CriticInspectInput } from "../src/builder/v3/critic/types.js";
import {
  criticContext,
  critique,
  critiqueLines,
  fakeInspector,
  firstPrompt,
  fixtureRoute,
  registry,
} from "./v3-critic-fixtures.js";

const ctx = await criticContext();
const prompt = firstPrompt(ctx);
const homeFile = ctx.site.pages.find((p) => p.route === "/")?.file as string;
const homeSrc = ctx.files.get(homeFile) as string;
const hero = ctx.site.pages.find((p) => p.route === "/")?.sections.find((s) => s.id === "hero");
const title = (hero?.props as { title?: string } | undefined)?.title as string;
const known = { phones: ["9161234567"], emails: [] };

const finding = (patch: unknown) => ({
  sign: "заголовок первого экрана теряется",
  where: "/@390#hero",
  severity: "P1",
  evidence: "изображение 1, первый экран",
  replace: "заголовок короче",
  edit: null,
  patch,
});

describe("V4-18 stubs in the critic", () => {
  test("S01–S04 are checks of the critic with the stub rubric's severities", () => {
    for (const c of STUB_CODES) expect(CHECK_CODES).toContain(c);
    expect(CHECK_RUBRIC.S02.severity).toBe("P1");
    const p = { route: "/", width: 390, scheme: "light" as const, section: "hero", message_ru: "x" };
    expect(problemPenalty([{ ...p, code: "S02" }])).toBeGreaterThan(problemPenalty([{ ...p, code: "S03" }]));
  });

  test("newStub: a placeholder, a dead link and a strange phone are new stubs of the file; a real text is not", () => {
    const swap = (to: string) => homeSrc.replace(JSON.stringify(title), JSON.stringify(to));
    expect(newStub(ctx.files, homeFile, swap("Лечим зубы без боли"), known)).toBeNull();
    expect(newStub(ctx.files, homeFile, swap("Заголовок"), known)).toMatch(/^S02 /);
    expect(newStub(ctx.files, homeFile, swap("Звоните +7 (495) 765-43-21"), known)).toMatch(/^S04 /);
    const dead = homeSrc.replace(
      "export default function",
      'const more = <a href="#">Ещё</a>;\nexport default function',
    );
    expect(newStub(ctx.files, homeFile, dead, known)).toMatch(/^S01 /);
  });

  test("the critic refuses an edit that adds a placeholder and passes the owner's contacts to the inspector", async () => {
    const stub = { file: homeFile, find: JSON.stringify(title), replace: JSON.stringify("Заголовок") };
    const fx = fixtureRoute(critiqueLines(prompt, [critique(2, [finding(stub)])]));
    const inputs: CriticInspectInput[] = [];
    const inspect = fakeInspector([]);
    const r = await runCritic(
      { ...ctx, route: fx.route },
      {
        inspect: (i) => {
          inputs.push(i);
          return inspect(i);
        },
        verify: null,
        registry,
        maxCycles: 1,
      },
    );
    expect(r.cycles[0]?.applied).toEqual([]);
    expect((r.cycles[0]?.rejected ?? []).map((x) => x.reason_ru).join(" | ")).toMatch(
      /добавляет заглушку: S02/,
    );
    expect(r.files.get(homeFile) ?? homeSrc).toContain(title);
    expect(inputs[0]?.contacts).toBeDefined();
  });
});
