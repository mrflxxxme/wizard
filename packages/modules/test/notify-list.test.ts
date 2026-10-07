// B2-47 (D76 control measurement 07.10.2026, brief mvp-08: G1-GOAL-GS-notify-3 «в списке уведомлений не сказано
// «владельцу»»): the owner's page «Уведомления» lists every notification of the plan — notify's own and the notify
// steps of the other modules' workflows (the weekly digest of «Отчёты» to the owner). The program of GS-notify-3 runs
// here on the page model (the visible strings of its Features list) for every CI matrix row with notify, the plan of
// all modules and plans of deals + notify + reports; the browser runs it in goals*.browser.test.ts.
import type { AppSpec } from "@wizard/appspec";
import { GOAL_PROGRAMS, type GoalRun, type GoalScenarioInput } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import { compilePlan, MODULES_WITH_CODE, matrixPlan, notifyManifest } from "../src/index.js";
import { allModulesPlan, dealsNotifyReportsPlans, testRegistry } from "./fixtures.js";

const registry = testRegistry();
const SCENARIO = "GS-notify-3";
const PAGE = "ui/pages/NotifySettings.tsx";

/** The visible text of the page's Features list: every string literal of the element (title, intro, items). */
function listText(src: string): string {
  const el = src.match(/<Features [\s\S]*?\/>/)?.[0] ?? "";
  return [...el.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join(" ");
}

/** Runs the program of GS-notify-3 against the page model; returns the failures (empty — it passes). */
async function runList(spec: AppSpec, files: Readonly<Record<string, string>>): Promise<string[]> {
  const failures: string[] = [];
  const scenario = notifyManifest.goalScenarios?.find(
    (s) => s.id === SCENARIO,
  ) as unknown as GoalScenarioInput;
  const text = listText(files[PAGE] ?? "");
  const loc = { first: () => loc, count: async () => (text ? 1 : 0), innerText: async () => text };
  const t = {
    spec,
    scenario,
    files: new Map(Object.entries(files)),
    step: () => {},
    fail: (reason: string, evidence?: string) => {
      failures.push(`${reason}${evidence ? ` (${evidence})` : ""}`);
    },
    as: async () => {},
    open: async () => {},
    settle: async () => {},
    page: { locator: () => loc },
  } as unknown as GoalRun;
  const program = GOAL_PROGRAMS[SCENARIO];
  if (!program) throw new Error(`no program for ${SCENARIO}`);
  await program(t);
  return failures;
}

const rows = MODULES_WITH_CODE.flatMap((d) =>
  (d.manifest.tests?.matrix ?? [])
    .filter((row) => d.manifest.id === "notify" || row.withModules?.includes("notify"))
    .map((row) => ({
      name: `${d.manifest.id} — ${row.name}`,
      plan: () => matrixPlan(registry, d.manifest.id, row),
    })),
);
const plans = [
  ...rows,
  { name: "все модули", plan: allModulesPlan },
  ...dealsNotifyReportsPlans(registry).map((x) => ({ name: `mvp-08: ${x.name}`, plan: () => x.plan })),
];

describe("GS-notify-3: the page «Уведомления» says what, to whom and by which channel (B2-47)", () => {
  test("every CI matrix row with notify is covered", () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });

  for (const x of plans)
    test(x.name, async () => {
      const r = compilePlan(x.plan(), registry, { appName: "Пример" });
      if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
      expect(r.scenarios.map((s) => s.id)).toContain(SCENARIO);
      expect(await runList(r.spec as AppSpec, r.files)).toEqual([]);
    });

  test("the weekly digest of «Отчёты» is on the list: to the owner, by e-mail, on Mondays", async () => {
    const x = dealsNotifyReportsPlans(registry).find((p) => p.name === "сделки и отчёты, сводка письмом");
    const r = compilePlan(x?.plan, registry, { appName: "Пример" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const text = listText(r.files[PAGE] ?? "");
    expect(text).toContain("Сводка владельцу по целям");
    expect(text).toContain("По понедельникам в 09:00: владельцу — письмом.");
    expect(text).not.toContain("Пока нечего отправлять");
  });

  test("the program fails a list that does not name the owner while the plan notifies the owner", async () => {
    const x = dealsNotifyReportsPlans(registry).find((p) => p.name === "сделки и отчёты, сводка письмом");
    const r = compilePlan(x?.plan, registry, { appName: "Пример" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const files = {
      ...r.files,
      [PAGE]:
        '<Features title="Настроенные уведомления" items={[{"title":"Пока нечего отправлять","text":"—"}]} />',
    };
    const failures = await runList(r.spec as AppSpec, files);
    expect(failures.join("\n")).toContain("не сказано «владельцу»");
  });

  test("the program asks for every kind of recipient the plan has: staff and clients too", async () => {
    const plan = matrixPlan(registry, "notify", {
      name: "x",
      params: { channels: ["email"], notify_staff: true },
      withModules: ["booking", "catalog", "staff"],
    });
    const r = compilePlan(plan, registry, { appName: "Пример" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const files = {
      ...r.files,
      [PAGE]:
        '<Features title="Настроенные уведомления" items={[{"title":"О записи","text":"владельцу — письмом"}]} />',
    };
    const failures = (await runList(r.spec as AppSpec, files)).join("\n");
    expect(failures).toContain("не сказано «сотрудникам»");
    expect(failures).toContain("не сказано «клиенту»");
  });
});
