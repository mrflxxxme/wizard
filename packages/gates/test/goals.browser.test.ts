// B2-24 (gates.yaml#G1.browser): G1-GOAL-<id> and G1-MOBILE-01 in Chromium — a page wider than a phone fails the
// mobile check with the element that sticks out; a failing program names the cell and the step; a scenario without a
// program and a v2 system without a browser are errors (blockers); a system without a plan and without a browser is
// unchanged. Positive runs on compiled modules: packages/modules/test/goals.browser.test.ts.
import { existsSync } from "node:fs";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Check,
  type GateReport,
  type GoalProgram,
  type GoalScenarioInput,
  isPassed,
  MOBILE_VIEWPORT,
  runG1,
} from "../src/index.js";
import { type G1Harness, g1Harness } from "./g1-helpers.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const SPEC: AppSpec = {
  specVersion: "1",
  app: { name: "Проверка", locale: "ru" },
  roles: [
    { name: "guest", label: "Посетитель", access: "public" },
    { name: "owner", label: "Владелец", access: "login", loginMethods: ["email_otp"], isAdmin: true },
  ],
  entities: [
    {
      name: "note",
      label: "Заметка",
      fields: [{ name: "title", label: "Заголовок", type: "string", required: true }],
    },
  ],
  permissions: [{ role: "owner", entity: "note", ops: ["create", "read", "update", "delete"] }],
  pages: [
    { route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["guest", "owner"] },
    { route: "/wide", title: "Широкая", file: "ui/pages/Wide.tsx", roles: ["guest"] },
  ],
} as unknown as AppSpec;

const HOME = `import { AppShell } from "@wizard/ui-kit";
export default function Home() {
  return <AppShell title="Проверка"><p>Добро пожаловать</p></AppShell>;
}`;
const WIDE = `import { AppShell } from "@wizard/ui-kit";
export default function Wide() {
  return <AppShell title="Широкая"><div data-testid="too-wide" style={{ width: 700 }}>Таблица шире телефона</div></AppShell>;
}`;
const files = (wide: boolean) =>
  new Map([
    ["ui/pages/Home.tsx", HOME],
    ["ui/pages/Wide.tsx", wide ? WIDE : WIDE.replace("width: 700", "maxWidth: 300")],
  ]);

const SC: GoalScenarioInput = {
  id: "GS-test-1",
  module: "test",
  goal: "leads",
  title: "Посетитель видит приветствие",
  steps: [{ actor: "visitor", text: "Открывает главную" }],
  expect: [{ kind: "page_text", text: "Видит «Добро пожаловать»" }],
};
const greets: GoalProgram = async (t) => {
  t.step("Посетитель открывает главную");
  await t.as("visitor");
  await t.open("/");
  t.step("Посетитель видит «Добро пожаловать»");
  await t.expectText("Добро пожаловать");
};
const missing: GoalProgram = async (t) => {
  await greets(t);
  t.step("Посетитель видит цену");
  await t.expectText("Цена 1000 ₽", { timeoutMs: 500 });
};
const ONE_CELL = [{ viewport: MOBILE_VIEWPORT, scheme: "dark" as const }];

let h: G1Harness;
let browser: Browser;
beforeAll(async () => {
  h = await g1Harness();
  if (hasChromium) browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  expect(await h.leftoverSchemas()).toBe(0);
  await h.close();
});

const of = (r: GateReport, prefix: string): Check[] => r.checks.filter((c) => c.id.startsWith(prefix));

describe("G1 browser checks: without a browser", () => {
  test("a system without a plan and without a browser: no browser checks, nothing changes", async () => {
    const r = await runG1(h.ctx({ spec: SPEC, files: files(true), milestone: "M1" }));
    expect(of(r, "G1-GOAL")).toEqual([]);
    expect(of(r, "G1-MOBILE")).toEqual([]);
  }, 120_000);

  test("goal scenarios without a browser: error, readiness is not given", async () => {
    const r = await runG1(h.ctx({ spec: SPEC, files: files(false), milestone: "M1", goalScenarios: [SC] }));
    expect(of(r, "G1-GOAL").map((c) => [c.id, c.status, c.severity])).toEqual([
      ["G1-GOAL-GS-test-1", "error", "blocker"],
    ]);
    expect(of(r, "G1-MOBILE").map((c) => c.status)).toEqual(["error"]);
    expect(of(r, "G1-MOBILE")[0]?.message_ru).toContain("нет браузера");
    expect(r.passed).toBe(false);
  }, 120_000);
});

describe.skipIf(!hasChromium)("G1 browser checks in chromium", () => {
  test("positive: the program passes, every page fits 390 px", async () => {
    const r = await runG1(
      h.ctx({ spec: SPEC, files: files(false), milestone: "M1", browser, goalScenarios: [SC] }),
      { goals: { programs: { "GS-test-1": greets } } },
    );
    expect(of(r, "G1-GOAL").map((c) => c.status)).toEqual(["pass"]);
    expect(of(r, "G1-GOAL")[0]?.message_ru).toContain("390 px, тёмная тема");
    expect(of(r, "G1-MOBILE").map((c) => c.status)).toEqual(["pass"]);
    expect(isPassed([...of(r, "G1-GOAL"), ...of(r, "G1-MOBILE")])).toBe(true);
  }, 180_000);

  test("negative: a page wider than the phone, a failing step, a scenario without a program", async () => {
    const shots: string[] = [];
    const r = await runG1(
      h.ctx({
        spec: SPEC,
        files: files(true),
        milestone: "M1",
        browser,
        goalScenarios: [SC, { ...SC, id: "GS-test-2", title: "Без программы" }],
      }),
      {
        goals: {
          programs: { "GS-test-1": missing },
          matrix: ONE_CELL,
          onScreenshot: (s) => shots.push(`${s.route}:${s.role}:${s.png.length > 0}`),
        },
      },
    );
    const goal = of(r, "G1-GOAL");
    expect(goal.map((c) => [c.id, c.status])).toEqual([
      ["G1-GOAL-GS-test-1", "fail"],
      ["G1-GOAL-GS-test-2", "error"],
    ]);
    expect(goal[0]?.message_ru).toContain("390 px, тёмная тема");
    expect(goal[0]?.message_ru).toContain("Посетитель видит цену");
    expect(goal[0]?.message_ru).toContain("Цена 1000 ₽");
    expect(goal[1]?.message_ru).toContain("не связан с проверкой");
    const mobile = of(r, "G1-MOBILE");
    expect(mobile.map((c) => [c.status, c.severity, c.file])).toEqual([
      ["fail", "blocker", "ui/pages/Wide.tsx"],
    ]);
    expect(mobile[0]?.message_ru).toContain("прокрутка вбок");
    expect(mobile[0]?.evidence).toContain("too-wide");
    expect(shots.sort()).toEqual(["/:guest:true", "/:owner:true", "/wide:guest:true"]);
    expect(r.passed).toBe(false);
  }, 180_000);
});
