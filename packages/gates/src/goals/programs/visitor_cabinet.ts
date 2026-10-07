// Goal scenarios of the module «Кабинет посетителя» (packages/modules/src/visitor_cabinet, modules.yaml#catalog
// visitor_cabinet): the role `visitor` (open sign-up, code on e-mail or phone), the page /me with «Мои записи» and
// «Мои заявки» — the visitor's own rows by the login contact (rowFilter $user.email | $user.phone).
import type { GoalProgram, GoalRun } from "../types.js";
import { bookVisit } from "./booking.js";
import { entityPage, leaveLead, openSection, pageApi, seedTexts, signInByCode, textOf } from "./shared.js";

const ROW = '[data-testid="wz-datatable-row"]';

/** The visitor role (open sign-up). */
function visitorRole(t: GoalRun): string {
  const role = t.spec.roles.find((r) => r.selfSignup === true && r.access === "login")?.name;
  if (!role) return t.fail("в системе нет входа для посетителей");
  return role;
}

/** Signs the visitor in by a code and opens the section of an entity on /me; checks own rows only. */
async function ownRows(t: GoalRun, entity: string, what: string): Promise<void> {
  const role = visitorRole(t);
  const page = entityPage(t, role, entity, "/me");
  if (!page) return t.fail(`в кабинете посетителя нет раздела «${what}»`);

  t.step("Посетитель входит в кабинет по коду");
  await signInByCode(t, role, page.route);
  if (new URL(t.page.url()).pathname !== page.route) await t.open(page.route);

  t.step(`Посетитель открывает «${what}»`);
  await openSection(t, entity);
  const mine = t.page.locator(ROW).filter({ hasText: t.marker }).first();
  try {
    await mine.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail(`в разделе «${what}» нет его записи`, await textOf(t, "body"));
  }

  t.step("Записей других посетителей нет");
  const rows = await t.page.locator(ROW).allInnerTexts();
  const foreign = rows.filter((r) => !r.includes(t.marker));
  if (foreign.length) t.fail(`в разделе «${what}» видно чужих записей: ${foreign.length}`);
  const text = rows.join(" ");
  if (seedTexts(t, entity, 20).some((v) => text.includes(v)))
    t.fail("посетитель видит данные других посетителей");
  const r = await pageApi(t, "GET", `/api/data/${entity}?limit=100`);
  const items = (r.body as { items?: Record<string, unknown>[] } | null)?.items ?? [];
  if (r.status !== 200) t.fail(`свои записи не отдаются посетителю (HTTP ${r.status})`);
  if (items.some((x) => x.name !== t.marker)) t.fail("через данные посетителю отдаются чужие записи");
}

/** GS-visitor_cabinet-1: the visitor books, signs in by a code and sees only own bookings. */
const myBookings: GoalProgram = async (t) => {
  t.step("Посетитель записывается");
  await bookVisit(t);
  await ownRows(t, "booking", "Мои записи");
};

/** GS-visitor_cabinet-2: the visitor leaves a lead, signs in by a code and sees only own leads with a status. */
const myLeads: GoalProgram = async (t) => {
  t.step("Посетитель оставляет заявку с контактом");
  await t.as("visitor");
  await leaveLead(t);
  await ownRows(t, "lead", "Мои заявки");
  const row = await textOf(t, `${ROW}:has-text("${t.marker}")`);
  const status = t.spec.entities.find((e) => e.name === "lead")?.fields.find((f) => f.name === "status");
  if (status?.enum && !status.enum.some((o) => row.includes(o.label)))
    t.fail("у заявки в кабинете не видно статуса", row);
};

export const VISITOR_CABINET_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-visitor_cabinet-1": myBookings,
  "GS-visitor_cabinet-2": myLeads,
};
