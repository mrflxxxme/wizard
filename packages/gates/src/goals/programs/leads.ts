// Goal scenarios of the module «Заявки» (packages/modules/src/leads, modules.yaml#catalog leads): entity `lead`,
// status new | in_work | done, the lead form of the site for the visitor (the landing's LeadForm, a v3 lead form
// pattern with the same data-wz-component), the cabinet for the owner.
import type { GoalOutboxMessage, GoalProgram } from "../types.js";
import {
  component,
  entityPage,
  enumLabel,
  leadFormRoute,
  openEntity,
  ownerRole,
  pageRoute,
  pageText,
  seedTexts,
  sendForm,
} from "./shared.js";

const LEAD_FORM = component("LeadForm");

const toOwner = (m: GoalOutboxMessage, owners: ReadonlySet<string>) =>
  (m.userId ? owners.has(m.userId) : false) ||
  (m.payload as { recipient?: unknown } | null)?.recipient === "owner";

/** GS-leads-1: the visitor leaves a lead, sees «Заявка отправлена»; the owner sees it as new and gets an e-mail. */
const leaveLead: GoalProgram = async (t) => {
  t.step("Посетитель заполняет форму заявки, отмечает согласие и отправляет");
  await t.as("visitor");
  // The page with the form (v2 `<LeadForm`, a v3 lead form pattern): the landing «/» first.
  await t.open(leadFormRoute(t) ?? "/");
  await sendForm(t, LEAD_FORM);

  t.step("Посетитель видит «Заявка отправлена»");
  await t.expectText("Заявка отправлена", { within: LEAD_FORM });

  t.step("Заявка сохранилась со статусом «новая»");
  const mine = await t.newRows("lead");
  if (mine.length !== 1) t.fail(`новых заявок в базе ${mine.length}, ожидалась одна`);
  const lead = mine[0] as Record<string, unknown>;
  if (lead.status !== "new") t.fail(`статус новой заявки «${String(lead.status)}», ожидался «new»`);

  t.step("Владелец открывает список заявок в кабинете");
  await t.as("owner");
  await openEntity(t, ownerRole(t.spec), "lead");
  const label = enumLabel(t.spec, "lead", "status", "new");
  const marked = Object.values(lead).some((v) => typeof v === "string" && v.includes(t.marker));
  if (marked) await t.expectNear(t.marker, label);
  else await t.expectText(label);

  t.step("Владельцу ушло письмо о новой заявке");
  await t.runJobs();
  const owners = new Set(t.userIds("owner"));
  // The channel of the plan: e-mail, or Telegram only when the plan has no e-mail (notify channels: [telegram]).
  const connectors = new Set((t.spec.integrations ?? []).map((i) => i.connector));
  const channel = connectors.has("email") || !connectors.has("telegram") ? "email" : "telegram";
  // In test mode the owner is a marker without an address (payload.recipient owner), an owner user — by userId.
  const mail = t.outbox(channel).filter((m) => toOwner(m, owners));
  if (mail.length === 0) {
    if (channel === "telegram") t.fail("сообщения владельцу о новой заявке нет в исходящих Telegram");
    const all = t.outbox("email");
    t.fail(
      "письма владельцу нет в исходящих",
      all.length
        ? `в исходящих: ${all.map((m) => `${m.integration}.${m.action} → ${m.userId ? "пользователю" : "без получателя"}`).join("; ")}`
        : "исходящих писем нет",
    );
  }
};

/** GS-leads-2: without signing in, the leads list is not shown and the data API refuses it. */
const leadsClosed: GoalProgram = async (t) => {
  t.step("Посетитель открывает адрес списка заявок без входа");
  await t.as("visitor");
  await t.open(
    entityPage(t, ownerRole(t.spec), "lead")?.route ?? pageRoute(t.spec, ownerRole(t.spec)) ?? "/cabinet",
  );

  t.step("Список заявок недоступен без входа");
  const text = await pageText(t);
  const leaked = seedTexts(t, "lead").find((v) => text.includes(v));
  if (leaked) t.fail("посетитель без входа видит чужую заявку на экране");
  const r = await t.api("GET", "/api/data/lead?limit=5");
  if (r.status !== 401 && r.status !== 403) t.fail(`заявки отдаются без входа (HTTP ${r.status})`);
};

export const LEADS_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-leads-1": leaveLead,
  "GS-leads-2": leadsClosed,
};
