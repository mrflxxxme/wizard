// The sale of a package in the goal scenarios (B2-18, B2-19): the owner sells a package of a sample tariff to the
// contacts of the booking form, so a visitor of a system with «Абонементы» (write-off by booking) can book. Shared by the
// programs of «Абонементы» and of «Запись по слотам» (bookVisit), apart from both so they do not import each other.
import type { AppSpec } from "@wizard/appspec";
import type { GoalRun } from "../types.js";

export const ITEM = "client_package";
/** Visits of the sample tariff (GS-packages-2 expects one less after the booking). */
export const VISITS = 4;

export const has = (spec: AppSpec, entity: string, field: string) =>
  spec.entities.some((e) => e.name === entity && e.fields.some((f) => f.name === field));
export const fieldLabel = (spec: AppSpec, entity: string, field: string) =>
  spec.entities.find((e) => e.name === entity)?.fields.find((f) => f.name === field)?.label ?? field;

/** The contacts the booking form gets from fillForm (goals/browser.ts SYNTHETIC): the package is sold to them. */
export function formContact(t: GoalRun): { phone: string; email: string } {
  return { phone: `+7${t.contact.phone}`, email: t.contact.email };
}

/** POST /api/data/<entity> as the current actor → the new record's id. */
export async function create(t: GoalRun, entity: string, data: Record<string, unknown>): Promise<string> {
  const r = await t.api("POST", `/api/data/${entity}`, data);
  const item = (r.body as { item?: { id?: string } } | null)?.item;
  if (r.status >= 300 || !item?.id)
    t.fail(
      `не удалось создать запись «${entity}»`,
      `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
  return item.id;
}

export async function patch(
  t: GoalRun,
  entity: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const r = await t.api("PATCH", `/api/data/${entity}/${id}`, data);
  if (r.status >= 300)
    t.fail(
      `не удалось изменить запись «${entity}»`,
      `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`,
    );
}

export async function row(t: GoalRun, entity: string, id: string): Promise<Record<string, unknown>> {
  const r = (await t.rows(entity)).find((x) => x.id === id);
  if (!r) t.fail(`записи «${entity}» нет в базе`);
  return r;
}

/**
 * The owner (signed in) sells a package of a sample tariff (4 visits and/or 30 days) to a client named by the run's
 * marker with these contacts and runs the jobs (packageSold fills the rest). Returns the package id.
 */
export async function sell(
  t: GoalRun,
  contact: { phone?: string; email?: string },
  opts: { visits?: number; consent?: boolean } = {},
): Promise<string> {
  const plan = await create(t, "package_plan", {
    name: `Тариф ${t.marker}`,
    ...(has(t.spec, "package_plan", "visits") ? { visits: opts.visits ?? VISITS } : {}),
    ...(has(t.spec, "package_plan", "days") ? { days: 30 } : {}),
  });
  const client = await create(t, "client", { name: t.marker, ...contact });
  const pkg = await create(t, ITEM, {
    client,
    plan,
    ...(opts.consent && has(t.spec, ITEM, "consent_messages") ? { consent_messages: true } : {}),
  });
  await t.runJobs();
  return pkg;
}

/** Whether a booking of the system takes a visit off a package (the booking page asks packageCheck first, B2-18). */
export const bookingByPackage = (spec: AppSpec): boolean => has(spec, "booking", "package_status");

/**
 * Booking scenarios of other modules in a system with «Абонементы» (B2-19): a visitor without a valid package cannot
 * book, so before the visitor books the owner sells a package to the contacts of the booking form — once per run
 * (two bookings of GS-client_card-1 share it). Nothing to do without the write-off.
 */
export async function ensurePackage(t: GoalRun): Promise<void> {
  if (!bookingByPackage(t.spec)) return;
  const c = formContact(t);
  const valid = (await t.rows(ITEM)).some(
    (p) => p.status === "active" && (p.email === c.email || p.phone === c.phone),
  );
  if (valid) return;
  await t.as("owner");
  await sell(t, c);
}
