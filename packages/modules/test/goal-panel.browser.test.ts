// B2-27 acceptance in Chromium: the goal panel of the owner on the cabinet design system v2 — metrics of each plan goal
// for the month and the week with a line in plain words, 1–3 hints «что улучшить» that lead to an action (a cabinet
// section or the platform in a new tab) and a clear empty state without data. The system «студия» (лендинг, заявки,
// уведомления письмом, сотрудники, клиенты, отчёты) passes G0 and G1 with GS-reports-1, 2, 5 and two own programs at
// 390 and 1280 px in the light and dark themes: cabinet look, AA contrast, labels, touch targets ≥ 44 px on the phone,
// no sideways scroll. Screenshots go to test/artifacts/goal-panel-*.png (CI artifact of the e2e job).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import {
  type GateContext,
  type GateReport,
  GOAL_PROGRAMS,
  type GoalProgram,
  type GoalRun,
  type GoalScenarioInput,
  runG0,
  runG1,
} from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "../../ui-kit/test/a11y/checks.js";
import { type CompileSuccess, compilePlan, PLATFORM_URL } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "artifacts");
const PANEL = "/cabinet/goals";
const keyPrefix = `b227${randomBytes(3).toString("hex")}`;

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_gp_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-goal-panel-test-"));
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: serializeQrKeyring(newQrKeyring()) }),
    env: {
      authModeDev: true,
      devLogin: false,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  if (!hasChromium) return;
  await browser?.close();
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);

/** «Студия»: заявки без Telegram, сотрудники и клиенты; цели — заявки и история клиента. */
function studioPlan(): SystemPlan {
  const plan = landingLeadsPlan();
  plan.niche = "студия растяжки";
  plan.goals = [
    { id: "leads", statement: "Заявки с сайта не теряются" },
    { id: "client_history", statement: "Клиенты возвращаются, история под рукой" },
  ];
  plan.custom = [];
  plan.modules = plan.modules.map((m) => (m.id === "notify" ? { ...m, params: { channels: ["email"] } } : m));
  plan.modules.push({ id: "staff" }, { id: "client_card" }, { id: "reports", params: { period: "month" } });
  return plan;
}

/** What the page shows about the look and a11y (runs in the browser after A11Y_SCRIPT). */
const PROBE = () => {
  const a = (window as unknown as { __a11y: A11yApi }).__a11y;
  const html = document.documentElement;
  const s = getComputedStyle(html);
  return {
    look: html.getAttribute("data-wz-look"),
    bg: s.getPropertyValue("--w-bg").trim(),
    cabBg: s.getPropertyValue("--w-cab-bg").trim(),
    contrast: a.contrast(),
    labels: a.labels(),
    touch: a.touch(),
    overflow: a.overflow(),
  };
};

/** Probes and a screenshot of the current page: problems of the look and a11y in this cell. */
async function shoot(t: GoalRun, name: string, problems: string[]): Promise<void> {
  // Colours are measured at rest: after a click (the period switch) the buttons' transitions must finish first.
  await t.page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, {
      timeout: 2_000,
    })
    .catch(() => {});
  await t.page.evaluate(A11Y_SCRIPT);
  const r = await t.page.evaluate(PROBE);
  const cell = `${t.viewport.width}-${t.scheme}`;
  writeFileSync(
    join(ARTIFACTS, `goal-panel-${name}-${cell}.png`),
    await t.page.screenshot({ fullPage: true }),
  );
  const p = [
    ...(r.look === "cabinet" ? [] : [`нет вида кабинета (data-wz-look=${r.look})`]),
    ...(r.bg === r.cabBg ? [] : [`фон ${r.bg} вместо ${r.cabBg}`]),
    ...r.contrast.map((x) => `контраст: ${x}`),
    ...r.labels.map((x) => `подпись: ${x}`),
    ...r.overflow.map((x) => `прокрутка вбок: ${x}`),
    ...(t.viewport.width <= 390 ? r.touch.map((x) => `касание < 44 px: ${x}`) : []),
  ];
  for (const x of p) problems.push(`${name} ${cell}: ${x}`);
}

const text = async (t: GoalRun, selector: string) =>
  (
    (await t.page
      .locator(selector)
      .first()
      .innerText()
      .catch(() => "")) ?? ""
  ).replace(/\s+/g, " ");

async function openPanel(t: GoalRun): Promise<void> {
  await t.open(PANEL);
  await t.page
    .locator('[data-wz-component="GoalHints"]')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => t.fail("на панели нет блока «Что улучшить»"));
}

/** With data: every lead is new — «В работу взято 0 % заявок»; the hints lead to the leads section and the platform. */
function hintsProgram(problems: string[]): GoalProgram {
  return async (t) => {
    t.step("Все заявки месяца — новые");
    await t.as("owner");
    const leads = await t.rows("lead");
    if (leads.length === 0) t.fail("в данных seed нет заявок");
    for (const r of leads) {
      const res = await t.api("PATCH", `/api/data/lead/${String(r.id)}`, { status: "new" });
      if (res.status >= 300) t.fail(`заявка не обновилась (HTTP ${res.status})`, JSON.stringify(res.body));
    }

    t.step("Владелец открывает панель цели");
    await openPanel(t);
    await t.expectText("Цель: Заявки с сайта не теряются");
    const goal = await text(t, '[data-testid="wz-stats--goal-leads"]');
    if (!/За 30 дней:/.test(goal)) t.fail("у цели нет строки простыми словами за 30 дней", goal);
    const handled = await text(t, '[data-testid="wz-stats-kpi-leads_handled"]');
    if (!/0\s?%/.test(handled)) t.fail("доля заявок в работе не 0 %", handled);

    t.step("Подсказки: ответственный за заявки (раздел кабинета) и Telegram (платформа)");
    const items = t.page.locator('[data-testid^="wz-goalhints-item-"]');
    const n = await items.count();
    if (n < 1 || n > 3) t.fail(`подсказок ${n}, а нужно от одной до трёх`);
    const owner = t.page.locator('[data-testid="wz-goalhints-item-leads_owner"]');
    if ((await owner.count()) === 0) t.fail("нет подсказки «Заявки остаются без ответа»");
    const ownerText = await text(t, '[data-testid="wz-goalhints-item-leads_owner"]');
    if (!ownerText.includes("В работу взято 0 % заявок"))
      t.fail("подсказка не называет долю заявок", ownerText);
    const tg = t.page.locator('[data-testid="wz-goalhints-action-leads_telegram"]');
    if ((await tg.getAttribute("href")) !== PLATFORM_URL || (await tg.getAttribute("target")) !== "_blank")
      t.fail("«Изменить в Born to Build» не ведёт на платформу в новой вкладке");
    await shoot(t, "hints", problems);

    t.step("Неделя: строка цели за 7 дней");
    await t.page.locator('[data-testid="wz-goals-period"]').getByRole("button", { name: "Неделя" }).click();
    await t.settle();
    const week = await text(t, '[data-testid="wz-stats--goal-leads"]');
    if (!/За 7 дней:/.test(week)) t.fail("после выбора недели строка цели не за 7 дней", week);
    await shoot(t, "week", problems);

    t.step("Ссылка подсказки открывает раздел «Заявка» кабинета");
    await t.page.locator('[data-testid="wz-goalhints-action-leads_owner"]').click();
    await t.settle();
    const tab = t.page.locator('[data-testid="wz-cabinet-tab-lead"]').first();
    await tab.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if ((await tab.getAttribute("aria-selected").catch(() => null)) !== "true")
      t.fail("по ссылке подсказки не открылся раздел заявок", t.page.url());
  };
}

/** Without data: every record removed — the panel says so in words, no hints yet. */
function emptyProgram(problems: string[]): GoalProgram {
  return async (t) => {
    t.step("В системе нет ни заявок, ни клиентов");
    await t.as("owner");
    for (let pass = 0; pass < 2; pass++)
      for (const e of t.spec.entities)
        for (const r of await t.rows(e.name)) await t.api("DELETE", `/api/data/${e.name}/${String(r.id)}`);
    for (const e of ["lead", "client"]) if ((await t.rows(e)).length) t.fail(`записи «${e}» не удалились`);

    t.step("Панель объясняет, что данных пока нет");
    await openPanel(t);
    await t.expectText("Данных за 30 дней пока нет");
    await t.expectText("Подсказки появятся, когда в системе наберутся данные");
    if ((await t.page.locator('[data-testid^="wz-goalhints-item-"]').count()) > 0)
      t.fail("без данных на панели есть подсказки");
    const goal = await text(t, '[data-testid="wz-stats--goal-leads"]');
    if (!goal.includes("данных пока нет")) t.fail("строка цели не говорит, что данных нет", goal);
    await shoot(t, "empty", problems);
  };
}

describe.skipIf(!hasChromium)("goal panel and hints in the cabinet (B2-27)", () => {
  test("«студия»: G0, G1 with GS-reports-1/2/5, hints and the empty state at 390/1280 × light/dark", async () => {
    const r = compilePlan(studioPlan(), testRegistry(), { appName: "Растяжка" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
    const ok = r as CompileSuccess;
    const own = ok.scenarios.filter((s) => s.module === "reports");
    expect(own.map((s) => s.id)).toEqual(["GS-reports-1", "GS-reports-2", "GS-reports-3", "GS-reports-5"]);
    const problems: string[] = [];
    const custom: GoalScenarioInput[] = [
      {
        id: "B227-hints",
        module: "reports",
        goal: "visibility",
        title: "Подсказки панели цели",
        steps: [],
        expect: [],
      },
      {
        id: "B227-empty",
        module: "reports",
        goal: "visibility",
        title: "Панель цели без данных",
        steps: [],
        expect: [],
      },
    ];
    const ctx: GateContext = {
      spec: ok.spec as AppSpec,
      prevSpec: null,
      specVersion: 1,
      files: new Map(Object.entries(ok.files)),
      env: "draft",
      systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
      db,
      milestone: "M1",
      runtime: rt,
      runtimeRole: role,
      browser,
      goalScenarios: [...own, ...custom],
    };
    expect(failed(await runG0(ctx)), "G0").toEqual([]);
    const g1 = await runG1(ctx, {
      goals: {
        programs: {
          ...GOAL_PROGRAMS,
          "B227-hints": hintsProgram(problems),
          "B227-empty": emptyProgram(problems),
        },
      },
    });
    expect(failed(g1), "G1").toEqual([]);
    for (const id of [...own.map((s) => s.id), "B227-hints", "B227-empty"])
      expect(g1.checks.find((c) => c.id === `G1-GOAL-${id}`)?.status, id).toBe("pass");
    expect(problems).toEqual([]);
  }, 600_000);
});
