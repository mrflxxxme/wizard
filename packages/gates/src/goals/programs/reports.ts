// Goal scenarios of the module «Отчёты и панель цели» (packages/modules/src/reports, modules.yaml#catalog reports): the
// owner's panel (/cabinet/goals) over the query goalMetrics {period} → {metrics: [{id, value, previous}], reports:
// [{entity, total, previous, byStatus}]} — tiles of the plan's metrics and reports by entity; the weekly digest e-mail.
import type { GoalProgram, GoalRun } from "../types.js";
import { ownerMail } from "./booking.js";
import { ownerRole, plain, textOf } from "./shared.js";

const KPI = '[data-testid^="wz-stats-kpi-"]';
const DAY = 86_400_000;

type Metric = { id: string; value: number | null; previous: number | null };
type Report = {
  entity: string;
  total: number;
  previous: number;
  byStatus: { value: string; count: number }[];
};

/** The owner's panel page (the page over goalMetrics). */
function panelPage(t: GoalRun): string {
  const owner = ownerRole(t.spec);
  const page = (t.spec.pages ?? []).find(
    (p) => p.roles.includes(owner) && (t.files.get(p.file) ?? "").includes('useQuery("goalMetrics"'),
  );
  if (!page) return t.fail("у владельца нет панели цели");
  return page.route;
}

/** The panel's numbers as the current actor asks them. */
async function goalMetrics(t: GoalRun, period: "week" | "month") {
  const r = await t.api("POST", "/api/fn/goalMetrics", { args: { period } });
  const result = (r.body as { result?: { metrics?: Metric[]; reports?: Report[] } } | null)?.result;
  return { status: r.status, metrics: result?.metrics ?? [], reports: result?.reports ?? [] };
}

/** The first number of a KPI's value («1 234», «62 %», «4,5»). */
async function kpiNumber(t: GoalRun, selector: string): Promise<number | null> {
  const text = await textOf(t, `${selector} dd`);
  const m = /-?\d[\d\s]*(?:[.,]\d+)?/.exec(plain(text));
  return m ? Number(m[0].replace(/\s/g, "").replace(",", ".")) : null;
}

/** Rows of an entity created in the last `days` days before `now` (the panel's current period). */
async function createdWithin(t: GoalRun, entity: string, days: number, now: number): Promise<number> {
  return (await t.rows(entity)).filter((r) => {
    const at = r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(String(r.created_at));
    return at >= now - days * DAY && at < now;
  }).length;
}

/** GS-reports-1: a metric per goal of the plan on the panel; the numbers match the seed's data. */
const metricPerGoal: GoalProgram = async (t) => {
  t.step("Владелец открывает панель цели");
  await t.as("owner");
  const data = await goalMetrics(t, "month");
  if (data.status !== 200) return t.fail(`показатели панели не считаются (HTTP ${data.status})`);
  const now = Date.now();
  await t.open(panelPage(t));
  await t.page
    .locator(KPI)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});

  t.step("По каждой цели плана есть метрика, числа совпадают с данными");
  if (data.metrics.length === 0) {
    await t.expectText("Показателей пока нет");
  }
  for (const m of data.metrics) {
    const sel = `[data-testid="wz-stats-kpi-${m.id}"]`;
    if ((await t.page.locator(sel).count()) === 0) t.fail(`на панели нет показателя ${m.id}`);
    const shown = await kpiNumber(t, sel);
    const want = m.value ?? 0;
    if (shown === null || Math.abs(shown - want) > Math.max(1, Math.abs(want) * 0.05))
      t.fail(`показатель ${m.id} на панели ${shown ?? "без числа"}, а по данным ${want}`);
  }
  // Independent of the query: the reports' «Новых записей» against the rows of the seed for the last 30 days.
  for (const r of data.reports) {
    const seen = await createdWithin(t, r.entity, 30, now);
    if (Math.abs(seen - r.total) > 0)
      t.fail(`отчёт «${r.entity}»: новых записей ${r.total}, а в данных ${seen}`);
  }
};

/** GS-reports-2: «Неделя» — every tile names the period before and the change; reports show new rows by status. */
const weekTrend: GoalProgram = async (t) => {
  t.step("Владелец открывает панель цели и выбирает «Неделя»");
  await t.as("owner");
  await t.open(panelPage(t));
  const week = t.page
    .locator('[data-testid="wz-goals-period"]')
    .getByRole("button", { name: "Неделя" })
    .first();
  if ((await week.count()) === 0) t.fail("на панели нет переключателя «Неделя»");
  await week.click();
  await t.settle();
  if ((await t.page.locator(KPI).count()) > 0) await t.expectText("за 7 дней");

  t.step("У каждой плитки подписан прошлый период и рост или снижение");
  const kpis = t.page.locator(KPI);
  for (let i = 0; i < (await kpis.count()); i++) {
    const text = plain(await kpis.nth(i).innerText());
    if (!/Прошлый период|Нет данных/.test(text)) t.fail("у плитки не подписан прошлый период", text);
  }

  t.step("Владелец открывает раздел «Отчёты»");
  const tab = t.page.locator('[data-testid="wz-cabinet-tab-reports"]').first();
  if ((await tab.count()) === 0) t.fail("на панели нет раздела «Отчёты»");
  await tab.click();
  await t.settle();

  t.step("У каждого раздела число новых записей и разбивка по статусам");
  const data = await goalMetrics(t, "week");
  for (const r of data.reports) {
    const box = `[data-testid="wz-stats--report-${r.entity}"]`;
    if ((await t.page.locator(box).count()) === 0) t.fail(`в отчётах нет раздела ${r.entity}`);
    const total = await kpiNumber(t, `${box} [data-testid="wz-stats-kpi-total"]`);
    if (total !== r.total)
      t.fail(`в отчёте ${r.entity} новых записей ${total ?? "нет"}, ожидалось ${r.total}`);
    const hint = await textOf(t, `${box} [data-testid="wz-stats-kpi-total"]`);
    if (!hint.includes("Прошлый период")) t.fail(`в отчёте ${r.entity} нет сравнения с прошлым периодом`);
    if (r.byStatus.length && (await t.page.locator(`${box} [data-testid="wz-stats-bar"]`).count()) === 0)
      t.fail(`в отчёте ${r.entity} нет разбивки по статусам`);
  }
};

/** GS-reports-3: without signing in the panel and its data are closed. */
const panelClosed: GoalProgram = async (t) => {
  t.step("Посетитель открывает адрес панели цели без входа");
  await t.as("visitor");
  await t.open(panelPage(t));

  t.step("Панель и её данные недоступны без входа владельца");
  if ((await t.page.locator(KPI).count()) > 0) t.fail("посетитель без входа видит показатели панели");
  const r = await goalMetrics(t, "month");
  if (r.status !== 401 && r.status !== 403) t.fail(`показатели панели отдаются без входа (HTTP ${r.status})`);
};

/** Next moment of a weekly cron «M H * * D» (Moscow) after `from`. */
function nextWeekly(cron: string, from: Date): Date | null {
  const m = /^(\d+) (\d+) \* \* (\d)$/.exec(cron.trim());
  if (!m) return null;
  const [minute, hour, dow] = [Number(m[1]), Number(m[2]), Number(m[3]) % 7];
  const msk = new Date(from.getTime() + 3 * 3_600_000);
  for (let d = 0; d <= 7; d++) {
    const day = new Date(
      Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + d, hour, minute),
    );
    const at = new Date(day.getTime() - 3 * 3_600_000);
    if (day.getUTCDay() === dow && at > from) return at;
  }
  return null;
}

/** GS-reports-4: on Monday at 9:00 the owner gets the e-mail «Итоги недели по целям». */
const weeklyDigest: GoalProgram = async (t) => {
  t.step("Время сдвигается на понедельник, 9:00");
  const wf = (t.spec.workflows ?? []).find((w) => w.trigger.type === "schedule" && w.trigger.cron);
  const at = wf?.trigger.cron ? nextWeekly(wf.trigger.cron, t.now) : null;
  if (!at) return t.fail("в системе нет еженедельной сводки");
  await t.runJobs();
  const before = ownerMail(t).length;
  await t.advance(Math.ceil((at.getTime() - t.now.getTime()) / 60_000) + 1);

  t.step("Владельцу ушло письмо «Итоги недели по целям»");
  const mail = ownerMail(t)
    .slice(before)
    .find((m) => /Итоги недели/i.test(`${m.subject} ${m.text}`));
  if (!mail) t.fail("письма владельцу со сводкой нет в исходящих");
};

export const REPORTS_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-reports-1": metricPerGoal,
  "GS-reports-2": weekTrend,
  "GS-reports-3": panelClosed,
  "GS-reports-4": weeklyDigest,
};
