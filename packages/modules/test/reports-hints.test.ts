// B2-27 «Панель цели в кабинете системы и подсказки улучшений»: the hint rules (which fit a plan, their conditions on
// the month's metrics, at most three, one per fix, each with an action), the goal line in plain words and the panel
// page that carries them. The panel through a runtime and a browser — goal-panel.browser.test.ts.
import type { SystemPlan } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  type CompileSuccess,
  compilePlan,
  goalPanelSource,
  goalsWithoutMetrics,
  HINT_BOUNDS,
  type HintRule,
  hintRules,
  MAX_HINTS,
  PLATFORM_URL,
  panelModel,
  reportsModule,
} from "../src/index.js";
import {
  goalSummary,
  HINT_MIN_EVENTS,
  hasData,
  hintFires,
  periodSpan,
  pickHints,
  plural,
} from "../src/reports/lib/goalPanel.js";
import type { GenContext } from "../src/types.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";
import { libraryPlan } from "./fixtures-b218.js";

const rule = (over: Partial<HintRule> & Pick<HintRule, "id" | "metric" | "when">): HintRule => ({
  goal: "leads",
  unit: "percent",
  title: over.id,
  text: "{value} против {previous}",
  action: { label: "Открыть", href: "/cabinet#lead", external: false },
  fix: over.id,
  ...over,
});

describe("hint conditions and the pick (lib/goalPanel.ts)", () => {
  test("gte / lte reach the bound; drop needs the share and the minimum before; unknown never fires", () => {
    const gte = rule({ id: "a", metric: "m", when: { op: "gte", value: 15 } });
    expect(hintFires(gte, { value: 15, previous: null })).toBe(true);
    expect(hintFires(gte, { value: 14.9, previous: 50 })).toBe(false);
    expect(hintFires(gte, { value: null, previous: 50 })).toBe(false);
    expect(hintFires(gte, undefined)).toBe(false);
    const lte = rule({ id: "b", metric: "m", when: { op: "lte", value: 70 } });
    expect(hintFires(lte, { value: 70, previous: null })).toBe(true);
    expect(hintFires(lte, { value: 70.1, previous: null })).toBe(false);
    const drop = rule({ id: "c", metric: "m", when: { op: "drop", share: 0.3, min: 5 } });
    expect(hintFires(drop, { value: 7, previous: 10 })).toBe(true);
    expect(hintFires(drop, { value: 8, previous: 10 })).toBe(false);
    expect(hintFires(drop, { value: 0, previous: 4 })).toBe(false);
    expect(hintFires(drop, { value: 0, previous: null })).toBe(false);
  });

  test("B2-19: a share with `min` fires only over at least that many events of the month; unknown base never", () => {
    expect(HINT_MIN_EVENTS).toBe(10);
    const share = rule({ id: "s", metric: "m", when: { op: "gte", value: 15, min: HINT_MIN_EVENTS } });
    // Two cancellations of three bookings are not «many cancellations».
    expect(hintFires(share, { value: 66.7, previous: null, base: 3 })).toBe(false);
    expect(hintFires(share, { value: 20, previous: null, base: 9 })).toBe(false);
    expect(hintFires(share, { value: 20, previous: null, base: 10 })).toBe(true);
    expect(hintFires(share, { value: 14, previous: null, base: 40 })).toBe(false);
    expect(hintFires(share, { value: 20, previous: null, base: null })).toBe(false);
    expect(hintFires(share, { value: 20, previous: null })).toBe(false);
    expect(pickHints([share], { m: { value: 50, previous: 10, base: 2 } })).toEqual([]);
  });

  test("at most three in the rules' order, one per fix, the values written with the unit", () => {
    const rules = [
      rule({ id: "r1", metric: "cancel", when: { op: "gte", value: 15 }, fix: "reminder" }),
      rule({ id: "r2", metric: "no_show", when: { op: "gte", value: 10 }, fix: "reminder" }),
      rule({ id: "r3", metric: "handled", when: { op: "lte", value: 70 } }),
      rule({ id: "r4", metric: "count", unit: "count", when: { op: "drop", share: 0.3, min: 5 } }),
      rule({ id: "r5", metric: "won", when: { op: "lte", value: 20 } }),
    ];
    const values = {
      cancel: { value: 23.5, previous: 10 },
      no_show: { value: 12, previous: 3 },
      handled: { value: 40, previous: 80 },
      count: { value: 3, previous: 10 },
      won: { value: 5, previous: 5 },
    };
    const hints = pickHints(rules, values);
    expect(hints.map((h) => h.id)).toEqual(["r1", "r3", "r4"]);
    expect(hints[0]?.text).toBe("23,5 % против 10 %");
    expect(hints[2]?.text).toBe("3 против 10");
    expect(hints[1]?.action).toEqual({ label: "Открыть", href: "/cabinet#lead", external: false });
    expect(pickHints(rules, values, 1).map((h) => h.id)).toEqual(["r1"]);
    // r1 does not fire: r2 fixes the same thing and takes its place.
    expect(pickHints(rules, { ...values, cancel: { value: 5, previous: 5 } }).map((h) => h.id)).toEqual([
      "r2",
      "r3",
      "r4",
    ]);
    expect(pickHints(rules, {})).toEqual([]);
  });

  test("the goal line in plain words; plural forms; data or not", () => {
    const up = { value: 12, previous: 10, better: "up" as const };
    const down = { value: 8, previous: 10, better: "up" as const };
    const fewer = { value: 5, previous: 20, better: "down" as const };
    const flat = { value: 3, previous: 3, better: "up" as const };
    const unknown = { value: 3, previous: null, better: "up" as const };
    expect(goalSummary([up, fewer, down], "week")).toBe("За 7 дней: 2 показателя стали лучше, 1 — хуже");
    expect(goalSummary([up], "month")).toBe("За 30 дней: 1 показатель стал лучше");
    expect(goalSummary([down, down, down, down, down], "week")).toBe("За 7 дней: 5 показателей стали хуже");
    expect(goalSummary([flat, unknown], "week")).toBe("За 7 дней: без изменений");
    expect(goalSummary([unknown], "week")).toBe("За 7 дней: сравнить пока не с чем");
    expect(goalSummary([{ value: null, previous: 4, better: "up" }], "month")).toBe(
      "За 30 дней: сравнить пока не с чем",
    );
    // Zero in both periods is no data yet, not «без изменений».
    expect(
      goalSummary(
        [
          { value: 0, previous: 0, better: "up" },
          { value: null, previous: null, better: "up" },
        ],
        "month",
      ),
    ).toBe("За 30 дней: данных пока нет");
    expect(goalSummary([], "week")).toBe("За 7 дней: данных пока нет");
    expect([1, 2, 5, 21, 1.5].map((n) => plural(n, ["пункт", "пункта", "пунктов"]))).toEqual([
      "пункт",
      "пункта",
      "пунктов",
      "пункт",
      "пункта",
    ]);
    expect([periodSpan("week"), periodSpan("month")]).toEqual(["за 7 дней", "за 30 дней"]);
    expect(hasData({ a: { value: 0 }, b: { value: null }, c: undefined })).toBe(false);
    expect(hasData({ a: { value: 0 }, b: { value: 2 } })).toBe(true);
  });
});

let captured: GenContext | undefined;
/** The real catalog; «Отчёты» also emits a helper file whose generator keeps the context the engine gives it. */
const registry = testRegistry([
  {
    ...reportsModule,
    files: {
      ...reportsModule.files,
      "functions/lib/zzCapture.ts": (ctx: GenContext) => {
        captured = ctx;
        return "export {};\n";
      },
    },
  },
]);

function compiled(plan: SystemPlan, opts: { platformUrl?: string; systemId?: string } = {}): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Пример", ...opts });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

/** The context the reports module's generators see for a compiled plan (parameters with defaults, spec, metrics). */
function genContext(plan: SystemPlan, opts: { platformUrl?: string; systemId?: string } = {}): GenContext {
  captured = undefined;
  compiled(plan, opts);
  if (!captured) throw new Error("«Отчёты» не в плане");
  return captured;
}

const page = (r: CompileSuccess) => r.files["ui/pages/ReportsGoals.tsx"] ?? "";
/** The rules a compiled page carries (the HINTS array of its data part). */
function pageHints(r: CompileSuccess): HintRule[] {
  const lines = page(r).split("\n");
  const at = lines.indexOf("const HINTS: HintRule[] = [");
  const out: HintRule[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l === "];") break;
    out.push(JSON.parse(l.trim().replace(/,$/, "")) as HintRule);
  }
  return out;
}

/** «Салон»: catalog + booking + clients + leads + notify + reports; `over` changes modules' params. */
function salonPlan(over: Record<string, Record<string, unknown>> = {}, drop: string[] = []): SystemPlan {
  const plan = landingLeadsPlan();
  plan.goals = [
    { id: "reduce_no_shows", statement: "Меньше отмен и неявок" },
    { id: "leads", statement: "Заявки не теряются" },
    { id: "fill_schedule", statement: "Расписание заполнено" },
  ];
  plan.modules.push(
    { id: "catalog", params: { with_duration: true } },
    { id: "booking" },
    { id: "client_card" },
    { id: "reports" },
  );
  plan.modules = plan.modules
    .filter((m) => !drop.includes(m.id))
    .map((m) => (over[m.id] ? { ...m, params: { ...(m.params ?? {}), ...over[m.id] } } : m));
  return plan;
}

const ids = (rules: readonly HintRule[]) => rules.map((r) => r.id);

describe("hint rules for a plan (reports/hints.ts)", () => {
  test("a reminder is on (notify, 24 h): no «turn the reminder on», but a second reminder; order by the plan's goals", () => {
    const rules = hintRules(genContext(salonPlan()));
    expect(ids(rules)).toEqual([
      "booking_second_reminder",
      "leads_owner",
      "leads_drop",
      "bookings_drop",
      "schedule_load",
      "packages_offer_returning_clients",
      "packages_offer_repeat_lead_clients",
    ]);
    const second = rules[0] as HintRule;
    expect(second).toMatchObject({
      goal: "reduce_no_shows",
      metric: "no_show_share",
      unit: "percent",
      when: { op: "gte", value: HINT_BOUNDS.noShowShare },
      action: { label: "Изменить в Born to Build", href: PLATFORM_URL, external: true },
    });
    // Without staff the owner is told to add someone on the platform.
    expect(rules[1]?.action.external).toBe(true);
    expect(rules[1]?.text).toContain("добавьте сотрудника");
    expect(rules.find((r) => r.id === "schedule_load")?.when).toEqual({
      op: "lte",
      value: 40,
      min: HINT_BOUNDS.minEvents,
    });
  });

  test("no reminder (notify without letters to visitors or without notify): «turn the reminder on» for cancels and no-shows", () => {
    const noLetters = hintRules(genContext(salonPlan({ notify: { visitor_emails: false } })));
    expect(ids(noLetters).slice(0, 2)).toEqual(["booking_reminder_cancel", "booking_reminder_no_show"]);
    expect(noLetters[0]?.fix).toBe(noLetters[1]?.fix);
    expect(ids(noLetters)).not.toContain("booking_second_reminder");
    const reschedule = hintRules(genContext(salonPlan({ booking: { reschedule_by_link: false } })));
    expect(ids(reschedule)).toContain("booking_reschedule");
  });

  test("leads: e-mail only — Telegram too; with staff — the leads section of the cabinet", () => {
    const plan = landingLeadsPlan();
    plan.modules = plan.modules.map((m) =>
      m.id === "notify" ? { ...m, params: { channels: ["email"] } } : m,
    );
    plan.modules.push({ id: "reports" });
    expect(ids(hintRules(genContext(plan)))).toEqual(["leads_owner", "leads_telegram", "leads_drop"]);
    const staffed = landingLeadsPlan();
    staffed.modules.push({ id: "staff" }, { id: "reports" });
    const r = compiled(staffed);
    const owner = hintRules(genContext(staffed)).find((x) => x.id === "leads_owner");
    expect(owner?.action).toEqual({ label: "Открыть заявки", href: "/cabinet#lead", external: false });
    // The section is there: the owner's cabinet has a section «lead».
    expect(r.files["ui/pages/Cabinet.tsx"]).toContain('{ id: "lead", label: "Заявка"');
  });

  test("resources, packages, deals: overdue, renewals and won deals lead to their action", () => {
    const lib = libraryPlan();
    lib.modules.push({ id: "reports" });
    const lr = hintRules(genContext(lib));
    expect(lr.find((x) => x.id === "overdue_contact")?.action.href).toBe("/cabinet#resource_issue");
    const off = libraryPlan();
    off.modules = off.modules.map((m) =>
      m.id === "resources" ? { ...m, params: { ...m.params, overdue_reminder: false } } : m,
    );
    off.modules.push({ id: "reports" });
    expect(ids(hintRules(genContext(off)))).toContain("overdue_reminder");
    expect(ids(hintRules(genContext(off)))).not.toContain("overdue_contact");

    const sales = landingLeadsPlan();
    sales.goals = [{ id: "deal_pipeline", statement: "Порядок в сделках" }];
    sales.modules.push(
      { id: "client_card" },
      { id: "deals" },
      { id: "packages", params: { write_off_on_booking: false } },
      { id: "reports" },
    );
    const ctx = genContext(sales);
    const rules = hintRules(ctx);
    expect(rules[0]).toMatchObject({
      id: "deals_won",
      metric: "deals_won_share",
      action: { href: "/cabinet#deal", external: false },
    });
    // With packages in the plan they are not offered; the renewal reminder is on by default (3 days).
    expect(ids(rules).some((x) => x.startsWith("packages_offer"))).toBe(false);
    expect(ids(rules)).not.toContain("packages_expiry");
    const cab = compiled(sales).files["ui/pages/Cabinet.tsx"] ?? "";
    for (const r of rules)
      if (!r.action.external)
        expect(cab, r.id).toContain(`{ id: ${JSON.stringify(r.action.href.split("#")[1])}`);
  });

  test("B2-19: «Изменить в Born to Build» opens the system on the platform; previews — the platform's main page", () => {
    const opts = { platformUrl: "https://borntobuild.ru/", systemId: "sys 1" };
    const rules = hintRules(genContext(salonPlan(), opts));
    const external = rules.filter((r) => r.action.external);
    expect(external.length).toBeGreaterThan(0);
    for (const r of external)
      expect(r.action, r.id).toEqual({
        label: "Изменить в Born to Build",
        href: "https://borntobuild.ru/s/sys%201",
        external: true,
      });
    expect(page(compiled(salonPlan(), opts))).toContain('"href":"https://borntobuild.ru/s/sys%201"');
    for (const r of hintRules(genContext(salonPlan())).filter((x) => x.action.external))
      expect(r.action.href, r.id).toBe(PLATFORM_URL);
  });

  test("B2-19: every share rule (gte / lte) needs HINT_MIN_EVENTS events; a drop keeps its own minimum", () => {
    for (const r of hintRules(genContext(salonPlan())))
      if (r.when.op === "drop") expect(r.when.min, r.id).toBe(HINT_BOUNDS.dropMin);
      else expect(r.when.min, r.id).toBe(HINT_MIN_EVENTS);
  });

  test("every rule of a big plan names a metric of the plan, a fix, a title and an action", () => {
    const ctx = genContext(salonPlan());
    const metrics = new Set(ctx.metrics.map((m) => m.id));
    for (const r of hintRules(ctx)) {
      expect(metrics.has(r.metric), r.id).toBe(true);
      expect(r.title.length, r.id).toBeGreaterThan(0);
      expect(r.text, r.id).toContain("{value}");
      expect(r.action.href, r.id).toMatch(/^(https:\/\/|\/cabinet)/);
    }
    expect(MAX_HINTS).toBe(3);
  });
});

describe("the panel page carries the goals, the hints and both periods", () => {
  test("hooks for the week and the month; HINTS as the rules of the plan; goals without metrics named", () => {
    const plan = salonPlan();
    plan.goals[1] = { id: "attract", statement: "Посетитель понимает предложение" };
    const r = compiled(plan);
    const src = page(r);
    expect(src).toContain('const week = useQuery("goalMetrics", { period: "week" });');
    expect(src).toContain('const month = useQuery("goalMetrics", { period: "month" });');
    // schedule_load is a function metric: asked from its query for both periods (a tile and a hint).
    expect(src).toContain('const fn0w = useQuery("scheduleLoad", { period: "week" });');
    expect(src).toContain('values.month["schedule_load"] = fnValue(fn0m.data);');
    expect(src).toContain(
      'import { Button, CabinetLayout, EmptyState, GoalHints, Loading, StatsReport } from "@wizard/ui-kit";',
    );
    expect(ids(pageHints(r))).toEqual(ids(hintRules(genContext(plan))));
    expect(src).toContain('const NO_METRICS: string[] = ["Посетитель понимает предложение"];');
    expect(src).toContain("pickHints(HINTS, month)");
  });

  test("goals without metrics: the panel's own goal «visibility» is not listed", () => {
    const ctx = genContext(salonPlan());
    const model = panelModel(ctx);
    expect(
      goalsWithoutMetrics(model, [
        { id: "visibility", statement: "Видеть цифры" },
        { id: "team_work", statement: "Разделить работу" },
        { id: "leads", statement: "Заявки" },
      ]),
    ).toEqual(["Разделить работу"]);
  });

  test("a plan without rules: an empty HINTS; the source is deterministic", () => {
    const plan = landingLeadsPlan();
    plan.modules = plan.modules.filter((m) => m.id !== "leads" && m.id !== "notify");
    plan.landing = {
      sections: (plan.landing?.sections ?? []).filter((s) => s.type !== "lead_form"),
    };
    plan.goals = [{ id: "attract", statement: "Посетитель понимает предложение" }];
    plan.custom = [];
    plan.modules.push({ id: "reports" });
    const r = compiled(plan);
    expect(pageHints(r)).toEqual([]);
    const ctx = genContext(plan);
    expect(goalPanelSource(panelModel(ctx), ctx, [], "X")).toBe(
      goalPanelSource(panelModel(ctx), ctx, [], "X"),
    );
  });
});
