// Goal scenarios of the module «Воронка сделок» (packages/modules/src/deals, modules.yaml#catalog deals): entity `deal`
// {title, status stage_1…N | won | lost, amount?, client?, lead?, assignee?}, the board /deals on the ui-kit
// StatusBoard (columns by status; tabs on a phone; «Перенести в…» on every card).
import type { GoalProgram, GoalRun } from "../types.js";
import {
  addRecord,
  entityPage,
  enumLabel,
  leaveLead,
  openEntity,
  ownerRole,
  recordAction,
  textOf,
} from "./shared.js";

const CARD = '[data-testid="wz-statusboard-card"]';
const column = (v: string) => `[data-testid="wz-statusboard-column-${v}"]`;

/** Stages of the board in order (deal.status), without «lost». */
function stages(t: GoalRun): string[] {
  const f = t.spec.entities.find((e) => e.name === "deal")?.fields.find((x) => x.name === "status");
  return (f?.enum ?? []).map((o) => o.value).filter((v) => v !== "lost");
}

/** Opens the board of a role. */
async function openBoard(t: GoalRun, role: string): Promise<void> {
  const board = entityPage(t, role, "deal", "/deals");
  if (!board) return t.fail("нет доски сделок");
  await t.open(board.route);
}

/** Shows a column (on a phone the board shows one column: its tab). */
async function showColumn(t: GoalRun, value: string): Promise<void> {
  const tab = t.page.getByRole("tab", { name: enumLabel(t.spec, "deal", "status", value) }).first();
  if ((await tab.count()) > 0 && (await tab.isVisible())) {
    await tab.click();
    await t.settle();
  }
}

/** The card of a deal (by its title) is visible in the column of a stage. */
async function expectInColumn(t: GoalRun, title: string, value: string): Promise<void> {
  await showColumn(t, value);
  const card = t.page
    .locator(`${column(value)} ${CARD}`)
    .filter({ hasText: title })
    .first();
  try {
    await card.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail(
      `сделки нет в колонке «${enumLabel(t.spec, "deal", "status", value)}»`,
      await textOf(t, column(value)),
    );
  }
}

/** Moves the deal's card to a stage with «Перенести в…» (the keyboard and touch alternative to dragging). */
async function moveCard(t: GoalRun, title: string, from: string, to: string): Promise<void> {
  await showColumn(t, from);
  const card = t.page
    .locator(`${column(from)} ${CARD}`)
    .filter({ hasText: title })
    .first();
  try {
    await card.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail(`сделки нет в колонке «${enumLabel(t.spec, "deal", "status", from)}»`);
  }
  const toggle = card.locator("button[aria-expanded]").first();
  if ((await toggle.count()) === 0) t.fail("у карточки сделки нет кнопки «Перенести в…»");
  await toggle.click();
  const write = t.page
    .waitForResponse((r) => r.request().method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/"), {
      timeout: 3_000,
    })
    .catch(() => null);
  await card.locator(`[data-testid="wz-statusboard-move-${to}"]`).first().click();
  if (!(await write)) t.fail("перенос сделки не сохранился");
  // The board re-reads its columns after its own move (B2-28): no reload, the card shows in its new column.
  await t.settle();
}

/** The owner adds a deal on the board (first stage); returns its row. */
async function ownerAddsDeal(t: GoalRun): Promise<Record<string, unknown>> {
  await t.as("owner");
  await openBoard(t, ownerRole(t.spec));
  const first = stages(t)[0] ?? "stage_1";
  await addRecord(t, "body", { status: first });
  const deal = (await t.newRows("deal")).find((d) => d.title === t.marker);
  if (!deal) return t.fail("новая сделка не сохранилась");
  if (deal.status !== first) t.fail(`новая сделка на этапе «${String(deal.status)}», ожидался первый`);
  // G1 serves no live updates (the event stream is closed): the board shows the new card after a reload.
  await openBoard(t, ownerRole(t.spec));
  return deal;
}

const statusOf = async (t: GoalRun, id: unknown) => (await t.rows("deal")).find((d) => d.id === id)?.status;

/** GS-deals-1: a deal moves to the next stage on the board. */
const nextStage: GoalProgram = async (t) => {
  t.step("Владелец создаёт сделку на первом этапе");
  const deal = await ownerAddsDeal(t);
  const [first, second] = stages(t);
  if (!first || !second) return t.fail("на доске меньше двух этапов");

  t.step("Владелец переносит её на следующий этап");
  await moveCard(t, t.marker, first, second);

  t.step("Сделка в колонке следующего этапа");
  if ((await statusOf(t, deal.id)) !== second) t.fail("этап сделки в базе не сменился");
  await expectInColumn(t, t.marker, second);
};

/** Conversion to «won» of the goal panel's function (dealFunnel); null — the system has no such function. */
async function wonShare(t: GoalRun): Promise<number | null> {
  const r = await t.api("POST", "/api/fn/dealFunnel", { args: {} });
  const v = (r.body as { result?: { value?: unknown } } | null)?.result?.value;
  return r.status === 200 && typeof v === "number" ? v : null;
}

/** GS-deals-4: a deal goes through all stages to «Успешно»; the conversion of the goal panel grows. */
const allStages: GoalProgram = async (t) => {
  await t.as("owner");
  const before = await wonShare(t);
  t.step("Владелец создаёт сделку и переносит её по всем этапам до «Успешно»");
  const deal = await ownerAddsDeal(t);
  const path = stages(t);
  for (let i = 1; i < path.length; i++) await moveCard(t, t.marker, path[i - 1] as string, path[i] as string);

  t.step("Сделка в колонке «Успешно»");
  if ((await statusOf(t, deal.id)) !== "won") t.fail("сделка в базе не дошла до «Успешно»");
  await expectInColumn(t, t.marker, "won");

  t.step("Конверсия в успешные на панели цели выросла");
  if (before === null) return;
  const after = await wonShare(t);
  if (after === null) return t.fail("показатель конверсии не считается");
  if (!(after > before)) t.fail(`конверсия в успешные не выросла: было ${before} %, стало ${after} %`);
};

/** GS-deals-3: a lead taken into work becomes a deal on the first stage of the board. */
const fromLead: GoalProgram = async (t) => {
  t.step("Посетитель оставляет заявку на сайте");
  await t.as("visitor");
  await leaveLead(t);
  const lead = (await t.newRows("lead"))[0];
  if (!lead) return t.fail("заявка не сохранилась");

  t.step("Владелец переводит заявку в работу");
  await t.as("owner");
  const area = await openEntity(t, ownerRole(t.spec), "lead");
  const row = t.page
    .locator(`${area} [data-testid="wz-datatable-row"]`)
    .filter({ hasText: t.marker })
    .first();
  try {
    await row.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("заявки нет в списке кабинета владельца");
  }
  await row.click();
  await t.settle();
  await recordAction(t, area, "to_in_work");
  await t.runJobs();

  t.step("Сделка из заявки в колонке первого этапа");
  const deal = (await t.newRows("deal")).find((d) => d.lead === lead.id);
  if (!deal) return t.fail("из заявки в работе не появилась сделка");
  const first = stages(t)[0] ?? "stage_1";
  if (deal.status !== first) t.fail(`сделка из заявки на этапе «${String(deal.status)}», ожидался первый`);
  await openBoard(t, ownerRole(t.spec));
  await expectInColumn(t, String(deal.title), first);
};

/** GS-deals-2: deals of two staff members — each sees only own on the board and in the data. */
const ownDeals: GoalProgram = async (t) => {
  t.step("Владелец назначает две сделки двум разным сотрудникам");
  const role = t.spec.roles.find((r) => !r.isAdmin && r.access !== "public" && !r.selfSignup)?.name;
  if (!role) return t.fail("в системе нет роли сотрудника");
  const mine = t.actorId({ role });
  const other = t.userIds("staff").find((id) => id !== mine) ?? t.userIds("owner")[0];
  if (!mine || !other) return t.fail("в системе нет двух пользователей для назначения сделок");
  await t.as("owner");
  const first = stages(t)[0] ?? "stage_1";
  const titles = [`${t.marker} А`, `${t.marker} Б`];
  for (const [i, assignee] of [mine, other].entries()) {
    const r = await t.api("POST", "/api/data/deal", { title: titles[i], status: first, assignee });
    if (r.status >= 300) t.fail(`сделка не создалась (HTTP ${r.status})`, JSON.stringify(r.body));
  }

  t.step("Сотрудник входит и открывает доску");
  await t.as({ role });
  await openBoard(t, role);
  await expectInColumn(t, titles[0] as string, first);

  t.step("Чужой сделки на доске нет");
  if (
    (await t.page
      .locator(CARD)
      .filter({ hasText: titles[1] as string })
      .count()) > 0
  )
    t.fail("сотрудник видит на доске чужую сделку");
  const r = await t.api("GET", "/api/data/deal?limit=100");
  const items = (r.body as { items?: { title?: unknown }[] } | null)?.items ?? [];
  if (items.some((d) => d.title === titles[1])) t.fail("чужая сделка отдаётся сотруднику через данные");
};

export const DEALS_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-deals-1": nextStage,
  "GS-deals-2": ownDeals,
  "GS-deals-3": fromLead,
  "GS-deals-4": allStages,
};
