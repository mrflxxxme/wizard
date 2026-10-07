// Goal scenarios of the module «Учёт выдачи и ресурсов» (packages/modules/src/resources, modules.yaml#catalog
// resources, B2-18): items `resource` (status available | issued | unavailable, or quantity and in_stock) and issues
// `resource_issue` (holder, status issued | overdue | returned, due_at, returned_at, e-mail with consent). The owner
// issues through the data API (setup), takes the item back with the status action of the cabinet card and checks the
// cabinet; time moves with the run's clock; messages are in the outbox.
import type { AppSpec } from "@wizard/appspec";
import type { GoalOutboxMessage, GoalProgram, GoalRun } from "../types.js";
import { enumLabel, ownerRole, pageRoute } from "./shared.js";

const ITEM = "resource";
const ISSUE = "resource_issue";
const DAY = 86_400_000;

const has = (spec: AppSpec, entity: string, field: string) =>
  spec.entities.some((e) => e.name === entity && e.fields.some((f) => f.name === field));

async function create(t: GoalRun, entity: string, data: Record<string, unknown>): Promise<string> {
  const r = await t.api("POST", `/api/data/${entity}`, data);
  const item = (r.body as { item?: { id?: string } } | null)?.item;
  if (r.status >= 300 || !item?.id)
    t.fail(
      `не удалось создать запись «${entity}»`,
      `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  return item.id;
}

async function row(t: GoalRun, entity: string, id: string): Promise<Record<string, unknown>> {
  const r = (await t.rows(entity)).find((x) => x.id === id);
  if (!r) t.fail(`записи «${entity}» нет в базе`);
  return r;
}

const cabinetOf = (t: GoalRun) => {
  // The shared cabinet of the owner (/cabinet) lists the module sections; other /cabinet/* pages are not it.
  const owner = ownerRole(t.spec);
  const route = t.spec.pages?.some((p) => p.route === "/cabinet" && p.roles.includes(owner))
    ? "/cabinet"
    : pageRoute(t.spec, owner);
  if (!route) t.fail("у владельца нет кабинета с учётом выдачи");
  return route;
};

/** Opens a section of the owner's cabinet (the query makes it a full load even from the same page). */
const openSection = (t: GoalRun, entity: string) => t.open(`${cabinetOf(t)}?section=${entity}#${entity}`);

/** The owner (signed in) issues a new item named by the run's marker until `dueInDays` from now. */
async function issue(
  t: GoalRun,
  dueInDays: number,
  extra: Record<string, unknown> = {},
): Promise<{ item: string; issue: string }> {
  const item = await create(t, ITEM, {
    name: t.marker,
    ...(has(t.spec, ITEM, "quantity") ? { quantity: 2 } : {}),
  });
  const id = await create(t, ISSUE, {
    resource: item,
    holder: t.marker,
    due_at: new Date(Date.now() + dueInDays * DAY).toISOString(),
    ...extra,
  });
  await t.runJobs();
  return { item, issue: id };
}

const ofRecord = (m: GoalOutboxMessage, id: string) =>
  (m.payload as { recordId?: unknown } | null)?.recordId === id;

/** GS-resources-1: an issue makes the item «Выдан» (or one less in stock); the return puts it back. */
const issueAndReturn: GoalProgram = async (t) => {
  t.step("Владелец выдаёт предмет со сроком возврата");
  await t.as("owner");
  const ids = await issue(t, 7);
  const counted = has(t.spec, ITEM, "in_stock");
  const given = await row(t, ITEM, ids.item);
  if (counted ? Number(given.in_stock) !== 1 : given.status !== "issued")
    t.fail("предмет после выдачи не числится выданным", `состояние: ${String(given.status)}`);
  await openSection(t, ISSUE);
  await t.expectNear(t.marker, enumLabel(t.spec, ISSUE, "status", "issued"));

  t.step("Отмечает возврат");
  const rowEl = t.page.locator('[data-testid="wz-datatable-row"]', { hasText: t.marker }).first();
  if ((await rowEl.count()) === 0) t.fail("выдачи нет в списке кабинета");
  await rowEl.click();
  // The status action of the cabinet card (screens/cabinet.ts: id to_<value>), not the column header of the same name.
  const back = t.page.locator('[data-testid$="wz-recordcard-action-to_returned"]').first();
  await back.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if ((await back.count()) === 0) t.fail("в карточке выдачи нет действия «Возвращено»");
  await back.click();
  // The card saves the status and hides the action of the status it has now.
  await back.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
  for (let i = 0; i < 20 && (await row(t, ISSUE, ids.issue)).status !== "returned"; i++)
    await t.page.waitForTimeout(250);
  await t.runJobs();

  t.step("Предмет снова «в наличии», выдача закрыта");
  const closed = await row(t, ISSUE, ids.issue);
  if (closed.status !== "returned" || !closed.returned_at) t.fail("выдача не закрыта возвратом");
  const item = await row(t, ITEM, ids.item);
  if (item.status !== "available" || (counted && Number(item.in_stock) !== 2))
    t.fail("после возврата предмет не в наличии", `состояние: ${String(item.status)}`);
  await openSection(t, ITEM);
  await t.expectNear(t.marker, enumLabel(t.spec, ITEM, "status", "available"));
};

/** GS-resources-2: past the due time the issue is overdue and the owner gets the message. */
const overdue: GoalProgram = async (t) => {
  t.step("Владелец выдаёт предмет на 1 день");
  await t.as("owner");
  const ids = await issue(t, 1);

  t.step("Время сдвигается на 2 дня");
  await t.advance(2 * 1440);

  t.step("Выдача в статусе «Просрочено»");
  const late = await row(t, ISSUE, ids.issue);
  if (late.status !== "overdue") t.fail(`статус выдачи «${String(late.status)}», ожидался «overdue»`);
  await openSection(t, ISSUE);
  await t.expectNear(t.marker, enumLabel(t.spec, ISSUE, "status", "overdue"));

  t.step("Владельцу ушло напоминание о просрочке");
  const owners = new Set(t.userIds("owner"));
  const toOwner = (m: GoalOutboxMessage) =>
    (m.userId ? owners.has(m.userId) : false) ||
    (m.payload as { recipient?: unknown } | null)?.recipient === "owner";
  // E-mail carries the record; a Telegram message (no personal data) — only the text about the overdue return.
  const tg = (m: GoalOutboxMessage) =>
    String((m.payload as { text?: unknown } | null)?.text ?? "").includes("Просрочен");
  const mail = [
    ...t.outbox("email").filter((m) => ofRecord(m, ids.issue)),
    ...t.outbox("telegram").filter(tg),
  ].filter(toOwner);
  if (mail.length === 0) t.fail("напоминания владельцу о просрочке нет в исходящих");
};

/** GS-resources-3: the borrower who agreed to letters gets a reminder a day before the due time. */
const dueReminder: GoalProgram = async (t) => {
  t.step("Владелец выдаёт предмет на 3 дня с почтой получателя и его согласием на письма");
  await t.as("owner");
  const ids = await issue(t, 3, { email: "borrower.goal@example.test", consent_messages: true });

  t.step("Время сдвигается к суткам до срока");
  await t.advance(2 * 1440 + 30);
  const still = await row(t, ISSUE, ids.issue);
  if (still.status !== "issued") t.fail(`выдача раньше срока в статусе «${String(still.status)}»`);

  t.step("Получателю ушло письмо с напоминанием вернуть предмет");
  const mail = t
    .outbox("email")
    .filter(
      (m) => ofRecord(m, ids.issue) && (m.payload as { recipient?: unknown } | null)?.recipient === "visitor",
    );
  if (mail.length === 0) t.fail("письма получателю о сроке возврата нет в исходящих");
};

/** GS-resources-4: an item on hand cannot be issued a second time. */
const secondIssue: GoalProgram = async (t) => {
  t.step("Владелец выдаёт предмет");
  await t.as("owner");
  const ids = await issue(t, 7);

  t.step("Пытается выдать тот же предмет ещё раз");
  const again = await t.api("POST", `/api/data/${ISSUE}`, {
    resource: ids.item,
    holder: `${t.marker} второй`,
  });

  t.step("Вторая выдача не сохраняется, предмет числится у первого получателя");
  if (again.status < 300) t.fail("предмет выдан второй раз, хотя его не вернули");
  const open = (await t.rows(ISSUE)).filter((r) => r.resource === ids.item && r.status !== "returned");
  if (open.length !== 1 || open[0]?.id !== ids.issue)
    t.fail(`открытых выдач предмета ${open.length}, ожидалась одна`);
};

export const RESOURCES_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-resources-1": issueAndReturn,
  "GS-resources-2": overdue,
  "GS-resources-3": dueReminder,
  "GS-resources-4": secondIssue,
};
