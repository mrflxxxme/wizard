// Goal scenarios of the module «Отчёты и панель цели» (packages/modules/src/reports, modules.yaml#catalog reports): the
// owner's panel (/cabinet/goals) over the query goalMetrics {period} → {metrics: [{id, value, previous}], reports:
// [{entity, total, previous, byStatus}]} — tiles of the plan's metrics and reports by entity; the weekly digest e-mail.
import type { GoalProgram, GoalRun } from "../types.js";
import { ownerMail } from "./booking.js";
import { ownerRole, plain, textOf } from "./shared.js";

const KPI = '[data-testid^="wz-stats-kpi-"]';
const DAY = 86_400_000;

type Metric = { id: string; value: number | null; previous: number | null; base?: number | null };
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

/**
 * Tile ids of the panel page (its TILES list): the panel shows 3–6 tiles — metrics of the plan's goals first — while
 * goalMetrics computes every metric of the plan (hints and digests use the rest). Null when the page has no such list.
 */
function panelTiles(t: GoalRun, route: string): string[] | null {
  const page = (t.spec.pages ?? []).find((p) => p.route === route);
  const src = page ? (t.files.get(page.file) ?? "") : "";
  const list = /const TILES: Tile\[\] = \[([\s\S]*?)\n\];/.exec(src)?.[1];
  return list === undefined ? null : [...list.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1] as string);
}

/** The panel's numbers as the current actor asks them. */
async function goalMetrics(t: GoalRun, period: "week" | "month") {
  const r = await t.api("POST", "/api/fn/goalMetrics", { args: { period } });
  const result = (r.body as { result?: { metrics?: Metric[]; reports?: Report[] } } | null)?.result;
  return { status: r.status, metrics: result?.metrics ?? [], reports: result?.reports ?? [] };
}

/** The first number of a KPI's value («1 234», «62 %», «4,5»). */
async function kpiNumber(t: GoalRun, selector: string): Promise<number | null> {
  return kpiValue(plain(await textOf(t, `${selector} dd`)));
}

/** Multipliers of the compact ru-RU notation the panel uses for large sums (ui-kit formatMoneyCompact). */
const COMPACT: readonly [RegExp, number][] = [
  [/^\s*тыс/i, 1e3],
  [/^\s*млн/i, 1e6],
  [/^\s*млрд/i, 1e9],
];

/**
 * The number a KPI tile shows: «18 600 ₽» → 18600, «18,6 тыс. ₽» → 18600 (the compact notation of large sums — read
 * as 18.6 before, a correct panel failed the goal, final measurement 10.10.2026), «62 %» → 62; null — no number.
 */
export function kpiValue(text: string): number | null {
  const m = /-?\d[\d\s]*(?:[.,]\d+)?/.exec(text);
  if (!m) return null;
  const n = Number(m[0].replace(/\s/g, "").replace(",", "."));
  const rest = text.slice(m.index + m[0].length);
  const mult = COMPACT.find(([re]) => re.test(rest))?.[1] ?? 1;
  return n * mult;
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
  const route = panelPage(t);
  await t.open(route);
  await t.page
    .locator(KPI)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});

  t.step("По каждой цели плана есть метрика, числа совпадают с данными");
  if (data.metrics.length === 0) {
    await t.expectText("Показателей пока нет");
  }
  // The panel's tiles (B2-19): a plan with many modules has more metrics in goalMetrics than the 6 tiles of the panel.
  const tiles = panelTiles(t, route);
  if (tiles && data.metrics.length > 0 && tiles.length === 0) t.fail("на панели нет ни одного показателя");
  for (const m of data.metrics) {
    if (tiles && !tiles.includes(m.id)) continue;
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

  // B2-27: the week's tiles show the week's numbers of goalMetrics.
  const weekData = await goalMetrics(t, "week");
  for (const m of weekData.metrics) {
    const sel = `[data-testid="wz-stats-kpi-${m.id}"]`;
    if ((await t.page.locator(sel).count()) === 0) continue;
    const shown = await kpiNumber(t, sel);
    const want = m.value ?? 0;
    if (shown === null || Math.abs(shown - want) > Math.max(1, Math.abs(want) * 0.05))
      t.fail(`показатель ${m.id} за неделю на панели ${shown ?? "без числа"}, а по данным ${want}`);
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

/** A hint rule as the panel page carries it (HINTS of packages/modules reports/page.ts, one JSON object a line). */
export type PanelHintRule = {
  id: string;
  metric: string;
  fix: string;
  when: { op: "gte" | "lte"; value: number; min?: number } | { op: "drop"; share: number; min: number };
  action: { label: string; href: string; external: boolean };
};
/** base — the events of the month the value stands on (null — unknown). */
type MonthValue = { value: number | null; previous: number | null; base: number | null };

/** The hint rules of the panel page source. */
export function panelHints(source: string): PanelHintRule[] {
  const lines = source.split("\n");
  const at = lines.indexOf("const HINTS: HintRule[] = [");
  if (at === -1) return [];
  const out: PanelHintRule[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "];") break;
    out.push(JSON.parse(l.trim().replace(/,$/, "")) as PanelHintRule);
  }
  return out;
}

/** Function metrics the page asks for the month: metric id → the module's query. */
function monthFunctions(source: string): Map<string, string> {
  const hooks = new Map(
    [...source.matchAll(/const (fn\d+m) = useQuery\("(\w+)", \{ period: "month" \}\);/g)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    ),
  );
  const out = new Map<string, string>();
  for (const m of source.matchAll(/values\.month\["(\w+)"\] = fnValue\((fn\d+m)\.data\);/g)) {
    const fn = hooks.get(m[2] as string);
    if (fn) out.set(m[1] as string, fn);
  }
  return out;
}

/**
 * The hints the panel must show (B2-27, modules.yaml#catalog reports): with data — rules in their order whose condition
 * holds on the month's values, one per fix, at most 3; without data (every value empty or zero) — none.
 */
export function expectedHints(
  rules: readonly PanelHintRule[],
  values: Readonly<Record<string, MonthValue>>,
): string[] {
  if (!Object.values(values).some((v) => v.value !== null && v.value !== 0)) return [];
  const out: string[] = [];
  const fixed = new Set<string>();
  for (const r of rules) {
    if (out.length >= 3) break;
    const v = values[r.metric];
    if (!v || v.value === null || fixed.has(r.fix)) continue;
    const w = r.when;
    const fires =
      w.op === "drop"
        ? v.previous !== null && v.previous >= w.min && v.value <= v.previous * (1 - w.share)
        : // A share with `min` goes by at least that many events of the month (B2-19).
          (w.min === undefined || (v.base !== null && v.base >= w.min)) &&
          (w.op === "gte" ? v.value >= w.value : v.value <= w.value);
    if (!fires) continue;
    fixed.add(r.fix);
    out.push(r.id);
  }
  return out;
}

/** The month's values the panel's hints go by: goalMetrics and the modules' function metrics, as the owner asks. */
async function monthValues(t: GoalRun, source: string): Promise<Record<string, MonthValue>> {
  const data = await goalMetrics(t, "month");
  if (data.status !== 200) return t.fail(`показатели панели не считаются (HTTP ${data.status})`);
  const values: Record<string, MonthValue> = {};
  for (const m of data.metrics) values[m.id] = { value: m.value, previous: m.previous, base: m.base ?? null };
  for (const [id, fn] of monthFunctions(source)) {
    const r = await t.api("POST", `/api/fn/${fn}`, { args: { period: "month" } });
    const res = (r.body as { result?: Partial<MonthValue> } | null)?.result;
    if (res)
      values[id] = { value: res.value ?? null, previous: res.previous ?? null, base: res.base ?? null };
  }
  return values;
}

const HINTS_ROOT = '[data-wz-component="GoalHints"]';
const HINT_ITEM = '[data-testid^="wz-goalhints-item-"]';

/** GS-reports-5: the panel shows the hints the rules give on the month's data (≤ 3); each leads to its action. */
const hintsLeadToActions: GoalProgram = async (t) => {
  t.step("Владелец открывает панель цели");
  await t.as("owner");
  const route = panelPage(t);
  const file = (t.spec.pages ?? []).find((p) => p.route === route)?.file ?? "";
  const source = t.files.get(file) ?? "";
  const rules = panelHints(source);
  const values = await monthValues(t, source);
  const want = expectedHints(rules, values);
  await t.open(route);
  await t.page
    .locator(HINTS_ROOT)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});
  if ((await t.page.locator(HINTS_ROOT).count()) === 0) t.fail("на панели нет блока «Что улучшить»");

  t.step("Не больше трёх подсказок по правилам, у каждой — ссылка на действие");
  const items = t.page.locator(`${HINTS_ROOT} ${HINT_ITEM}`);
  const shown: string[] = [];
  for (let i = 0; i < (await items.count()); i++)
    shown.push(((await items.nth(i).getAttribute("data-testid")) ?? "").replace("wz-goalhints-item-", ""));
  if (shown.length > 3) t.fail(`подсказок ${shown.length}, а нужно не больше трёх`);
  if (shown.join(",") !== want.join(","))
    t.fail(
      `подсказки на панели: ${shown.join(", ") || "нет"}, а по правилам и данным: ${want.join(", ") || "нет"}`,
    );
  if (shown.length === 0 && (await t.page.locator(`${HINTS_ROOT} [data-testid="wz-empty"]`).count()) === 0)
    t.fail("без подсказок нет пояснения, почему их нет");
  let inside: string | null = null;
  for (const id of shown) {
    const link = t.page.locator(`[data-testid="wz-goalhints-action-${id}"]`).first();
    const href = (await link.getAttribute("href")) ?? "";
    const rule = rules.find((r) => r.id === id);
    if (!rule || href !== rule.action.href)
      return t.fail(`у подсказки ${id} ссылка «${href}», а не на действие правила`);
    if (rule.action.external) {
      // The system's page on the platform (platformSystemUrl; http on a local platform) or its main page.
      if (!/^https?:\/\//.test(href) || (await link.getAttribute("target")) !== "_blank")
        t.fail(`подсказка ${id}: ссылка на платформу не открывается в новой вкладке`, href);
    } else if (!href.startsWith("/")) t.fail(`подсказка ${id}: ссылка «${href}» не ведёт в кабинет`);
    else inside ??= href;
  }

  if (inside) {
    t.step("Ссылка подсказки открывает нужный раздел кабинета");
    await t.open(inside);
    const section = decodeURIComponent(inside.split("#")[1] ?? "");
    if (section) {
      const tab = t.page.locator(`[data-testid="wz-cabinet-tab-${section}"]`).first();
      await tab.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
      if ((await tab.getAttribute("aria-selected").catch(() => null)) !== "true")
        t.fail(`по ссылке подсказки не открылся раздел «${section}»`, inside);
    }
  }
};

export const REPORTS_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-reports-1": metricPerGoal,
  "GS-reports-2": weekTrend,
  "GS-reports-3": panelClosed,
  "GS-reports-4": weeklyDigest,
  "GS-reports-5": hintsLeadToActions,
};
