// Goal scenarios of the module «Сотрудники и роли» (packages/modules/src/staff, modules.yaml#catalog staff): roles
// staff, staff_2… (closed sign-up, a code on e-mail or phone), the owner's page «Сотрудники и роли» with the invitation
// (/_wizard/team of the runtime over POST /api/admin/invite), a cabinet per role with its sections only.
import type { GoalProgram, GoalRun } from "../types.js";
import {
  entityLabel,
  ownerRole,
  pageApi,
  pageText,
  phoneLogin,
  press,
  sectionIds,
  seedTexts,
  signInByCode,
  textOf,
} from "./shared.js";

const FORBIDDEN = '[data-testid="wz-appshell-forbidden"]';

/** Staff roles in the plan's order (staff, staff_2, …). */
const staffRoles = (t: GoalRun) =>
  t.spec.roles.filter((r) => r.access === "login" && !r.isAdmin && !r.selfSignup).map((r) => r.name);

/** The owner's page «Сотрудники и роли». */
function teamPage(t: GoalRun): string {
  const owner = ownerRole(t.spec);
  const page = (t.spec.pages ?? []).find(
    (p) => p.roles.includes(owner) && (t.files.get(p.file) ?? "").includes("/_wizard/team"),
  );
  if (!page) return t.fail("у владельца нет раздела «Сотрудники и роли»");
  return page.route;
}

/** The cabinet of a staff role (its first page under /cabinet). */
function cabinetOf(t: GoalRun, role: string): string {
  const page = (t.spec.pages ?? [])
    .filter((p) => p.roles.includes(role) && p.route.startsWith("/cabinet"))
    .sort((a, b) => a.route.length - b.route.length)[0];
  if (!page) return t.fail(`у роли «${role}» нет кабинета`);
  return page.route;
}

/** Entities a role may read (its sections). */
const readable = (t: GoalRun, role: string) =>
  new Set(t.spec.permissions.filter((p) => p.role === role && p.ops.includes("read")).map((p) => p.entity));

/**
 * The owner's settings are closed to the current (staff) actor: the invitation page answers «Нет доступа», the API
 * refuses an invitation; the owner's page (when the shell shows it at all) holds no data of the seed.
 */
async function ownerPagesClosed(t: GoalRun, route: string): Promise<void> {
  await t.open(route);
  const forbidden = t.page.locator(FORBIDDEN).first();
  if ((await forbidden.count()) === 0 || !(await forbidden.isVisible())) {
    const text = await pageText(t);
    const leaked = seedTexts(t, "users").find((v) => text.includes(v));
    if (leaked) t.fail("сотруднику видны данные раздела «Сотрудники и роли»");
  }
  await t.page.goto(`${new URL(t.page.url()).origin}/_wizard/team`, { waitUntil: "load" });
  const team = await textOf(t, "body");
  if (!/Нет доступа/.test(team) || (await t.page.locator('[data-testid="wz-team-form"]').count()) > 0)
    t.fail("сотруднику открыта страница приглашения сотрудников", team.slice(0, 200));
  // The page's session: the staff member who signed in on the page (or the seed session of the role).
  const invite = await pageApi(t, "POST", "/api/admin/invite", {
    role: staffRoles(t)[0],
    email: "x@example.test",
  });
  if (invite.status !== 401 && invite.status !== 403)
    t.fail(`сотрудник может приглашать других (HTTP ${invite.status})`);
}

/** GS-staff-1: the owner invites a staff member; the staff member signs in by a code and sees the work, not settings. */
const invited: GoalProgram = async (t) => {
  const role = staffRoles(t)[0];
  if (!role) return t.fail("в системе нет роли сотрудника");
  const phone = phoneLogin(t.spec, role);

  t.step("Владелец открывает «Сотрудники и роли» и приглашает сотрудника");
  await t.as("owner");
  await t.open(teamPage(t));
  await press(t, "Пригласить сотрудника");
  const form = '[data-testid="wz-team-form"]';
  try {
    await t.page.locator(form).waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("не открылась форма приглашения", await textOf(t, "body"));
  }
  await t.page.locator('[data-testid="wz-team-role"]').selectOption(role);
  await t.page
    .locator('[data-testid="wz-team-contact"]')
    .fill(phone ? `+7${t.contact.phone}` : t.contact.email);
  await t.page.locator('[data-testid="wz-team-submit"]').click();
  const result = t.page.locator('[data-testid="wz-team-result"]');
  try {
    await result.filter({ hasText: /отправлено|добавлен/ }).waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    t.fail("приглашение не отправлено", await textOf(t, '[data-testid="wz-team-result"]'));
  }
  if (
    !phone &&
    !t.serviceMessages().some((m) => (m.payload as { to?: unknown } | null)?.to === t.contact.email)
  )
    t.fail("письма с приглашением нет в исходящих");

  t.step("Сотрудник входит по коду");
  await t.as("visitor");
  const cabinet = cabinetOf(t, role);
  await signInByCode(t, role, cabinet);

  t.step("Сотрудник видит рабочие разделы");
  if (new URL(t.page.url()).pathname !== cabinet) await t.open(cabinet);
  const sections = (await sectionIds(t)).filter((s) => s !== "mydata");
  const own = readable(t, role);
  if (own.size > 0 && sections.length === 0)
    t.fail("в кабинете сотрудника нет рабочих разделов", await textOf(t, "body"));
  const extra = sections.filter((s) => !own.has(s));
  if (extra.length)
    t.fail(`сотруднику видны чужие разделы: ${extra.map((e) => entityLabel(t.spec, e)).join(", ")}`);

  t.step("Раздел «Сотрудники и роли» недоступен");
  await ownerPagesClosed(t, teamPage(t));
};

/** GS-staff-2: a role with limited sections sees only them; another section's address and data are closed. */
const ownSections: GoalProgram = async (t) => {
  const role = staffRoles(t)[0];
  if (!role) return t.fail("в системе нет роли сотрудника");
  const own = readable(t, role);

  t.step("Сотрудник входит под ролью 1 и открывает кабинет");
  await t.as({ role });
  await t.open(cabinetOf(t, role));

  t.step("В кабинете только разделы его роли");
  const sections = (await sectionIds(t)).filter((s) => s !== "mydata");
  const extra = sections.filter((s) => !own.has(s));
  if (extra.length)
    t.fail(`в кабинете видны чужие разделы: ${extra.map((e) => entityLabel(t.spec, e)).join(", ")}`);
  if (own.size > 0 && sections.length === 0) t.fail("в кабинете нет разделов его роли");

  t.step("Сотрудник открывает адрес раздела, которого нет в его роли");
  const owner = ownerRole(t.spec);
  const other = (t.spec.pages ?? []).find(
    (p) => !p.roles.includes(role) && p.roles.some((r) => r !== "guest"),
  );
  if (other) {
    await t.open(other.route);
    const text = await pageText(t);
    const foreign = t.spec.entities.filter((e) => !own.has(e.name)).map((e) => e.name);
    const leaked = foreign.flatMap((e) => seedTexts(t, e)).find((v) => text.includes(v));
    if (leaked) t.fail(`на странице «${other.title}» сотруднику видны чужие данные`);
  }
  for (const e of t.spec.entities.filter((x) => !own.has(x.name))) {
    const publicRead = t.spec.permissions.some(
      (p) =>
        p.entity === e.name &&
        p.ops.includes("read") &&
        t.spec.roles.find((r) => r.name === p.role)?.access === "public",
    );
    if (publicRead) continue;
    const r = await pageApi(t, "GET", `/api/data/${e.name}?limit=5`);
    if (r.status !== 401 && r.status !== 403)
      t.fail(`данные раздела «${entityLabel(t.spec, e.name)}» отдаются сотруднику (HTTP ${r.status})`);
  }
  await ownerPagesClosed(
    t,
    (t.spec.pages ?? []).find((p) => p.roles.includes(owner) && p.route === "/cabinet")?.route ?? teamPage(t),
  );
};

export const STAFF_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-staff-1": invited,
  "GS-staff-2": ownSections,
};
