// Goal scenarios of the module «Напоминания и уведомления» (packages/modules/src/notify, modules.yaml#catalog notify):
// workflows with notify steps over the system's email/telegram integrations, the owner's page «Уведомления».
import type { GoalOutboxMessage, GoalProgram, GoalRun } from "../types.js";
import { bookVisit, hasLink, scheduleOffsets, visitorMail } from "./booking.js";
import { component, leaveLead, ownerRole, plain, textOf } from "./shared.js";

type NotifyParams = { integration?: unknown; to?: unknown };

/** GS-notify-3: the owner's page lists what is sent, to whom and by which channel. */
const settingsPage: GoalProgram = async (t) => {
  t.step("Владелец открывает раздел «Уведомления» в кабинете");
  const owner = ownerRole(t.spec);
  const page = (t.spec.pages ?? []).find((p) => p.roles.includes(owner) && p.title === "Уведомления");
  if (!page) return t.fail("в кабинете владельца нет раздела «Уведомления»");
  await t.as("owner");
  await t.open(page.route);

  t.step("Список уведомлений: о чём, кому и каким каналом");
  const list = component("Features");
  const text = await textOf(t, list);
  if (!text) t.fail("в разделе «Уведомления» нет списка уведомлений");
  const steps = (t.spec.workflows ?? []).flatMap((w) =>
    w.steps.filter((s) => s.type === "notify").map((s) => (s.params ?? {}) as NotifyParams),
  );
  const connector = new Map((t.spec.integrations ?? []).map((i) => [i.name, i.connector]));
  const channels = new Set(steps.map((s) => connector.get(String(s.integration))));
  const want: [boolean, RegExp, string][] = [
    [steps.some((s) => s.to === "$owner"), /владельц/i, "владельцу"],
    [channels.has("email"), /письм/i, "письмом"],
    [channels.has("telegram"), /telegram/i, "в Telegram"],
  ];
  for (const [needed, re, word] of want)
    if (needed && !re.test(text))
      t.fail(`в списке уведомлений не сказано «${word}»`, `в списке: ${plain(text).slice(0, 300)}`);
  if (steps.length > 0 && /Пока нечего отправлять/.test(text))
    t.fail("уведомления настроены, а список пишет «Пока нечего отправлять»");
};

const connector = (t: GoalRun, integration: string) =>
  (t.spec.integrations ?? []).find((i) => i.name === integration)?.connector;

const toOwner = (m: GoalOutboxMessage, owners: ReadonlySet<string>) =>
  (m.userId ? owners.has(m.userId) : false) ||
  (m.payload as { recipient?: unknown } | null)?.recipient === "owner";

/** GS-notify-2: a lead with a name and a phone → a Telegram message to the owner with a link, without them. */
const telegramWithoutPd: GoalProgram = async (t) => {
  t.step("Посетитель отправляет заявку с именем и телефоном");
  await t.as("visitor");
  const filled = await leaveLead(t);
  const lead = (await t.newRows("lead"))[0];
  if (!lead) return t.fail("заявка не сохранилась");

  t.step("Владельцу ушло сообщение в Telegram со ссылкой, без имени и телефона");
  await t.runJobs();
  const owners = new Set(t.userIds("owner"));
  const sent = t.outbox("telegram").filter((m) => toOwner(m, owners));
  if (sent.length === 0) t.fail("сообщения владельцу в Telegram нет в исходящих");
  const pd = [lead.name, lead.phone, lead.email, ...Object.values(filled)]
    .filter((v): v is string => typeof v === "string" && v.length >= 4 && v !== "да")
    .map((v) => v.replace(/^\+7/, ""));
  // The link: in the text of a live render; in outbox mode the runtime leaves {{link}} empty — then the step must carry
  // the link (params.link) and the text must offer it.
  const linked = (t.spec.workflows ?? []).some((w) =>
    w.steps.some(
      (s) =>
        s.type === "notify" &&
        typeof (s.params as (NotifyParams & { link?: unknown }) | undefined)?.link === "string" &&
        connector(t, String((s.params as NotifyParams).integration)) === "telegram",
    ),
  );
  for (const m of sent) {
    const body = JSON.stringify(m.payload);
    const leak = pd.find((v) => body.includes(v));
    if (leak) t.fail("в сообщении Telegram есть персональные данные из заявки");
    if (!/https?:\/\/|\/cabinet/.test(body) && !(linked && /ссылк/i.test(body)))
      t.fail("в сообщении Telegram нет ссылки на заявку в кабинете", body.slice(0, 300));
  }
};

/** GS-notify-1: a booking with consent to e-mails → the reminder at its time with date, time and a cancel link. */
const reminder: GoalProgram = async (t) => {
  t.step("Посетитель записывается на будущий день с согласием на письма");
  const visit = await bookVisit(t);
  const booking = (await t.newRows("booking"))[0];
  if (!booking) return t.fail("запись не сохранилась");
  if (booking.status === "new") {
    t.step("Владелец подтверждает запись");
    const r = await (async () => {
      await t.as("owner");
      return t.api("PATCH", `/api/data/booking/${String(booking.id)}`, { status: "confirmed" });
    })();
    if (r.status >= 300) t.fail(`владелец не может подтвердить запись (HTTP ${r.status})`);
  }
  await t.runJobs();
  const before = visitorMail(t, booking.id).length;

  t.step("Время сдвигается до момента напоминания");
  const offset = Math.min(...scheduleOffsets(t.spec, "booking"));
  if (!Number.isFinite(offset)) return t.fail("в системе нет напоминания о записи");
  const starts = booking.starts_at instanceof Date ? booking.starts_at : new Date(String(booking.starts_at));
  const due = starts.getTime() + offset * 60_000;
  await t.advance(Math.max(1, Math.ceil((due - t.now.getTime()) / 60_000) + 1));

  t.step("Посетителю ушло письмо-напоминание с датой, временем и ссылкой отмены");
  const mails = visitorMail(t, booking.id).slice(before);
  const remind = mails.find((m) => /напомина|remind/i.test(`${m.template ?? ""} ${m.subject} ${m.text}`));
  if (!remind)
    return t.fail(
      "письма-напоминания посетителю нет в исходящих",
      mails.length
        ? `письма посетителю: ${mails.map((m) => m.subject).join("; ")}`
        : "новых писем посетителю нет",
    );
  // A rendered letter shows the time itself; an unrendered one (outbox mode) — the template's date placeholder.
  if (remind.rendered ? !remind.text.includes(visit.time) : !remind.text.includes("{{starts_at}}"))
    t.fail("в напоминании нет даты и времени записи", remind.text.slice(0, 200));
  // The cancel link is in the reminder when the plan lets visitors cancel by a link (booking cancel_by_link).
  const withCancel = (t.spec.workflows ?? []).some(
    (w) =>
      w.trigger.type === "schedule" &&
      w.trigger.entity === "booking" &&
      w.steps.some((s) => s.type === "notify" && (s.params as { cancel?: unknown } | undefined)?.cancel),
  );
  if (withCancel && !hasLink(remind, "cancel")) t.fail("в напоминании нет ссылки отмены");
};

export const NOTIFY_PROGRAMS: Readonly<Record<string, GoalProgram>> = {
  "GS-notify-1": reminder,
  "GS-notify-2": telegramWithoutPd,
  "GS-notify-3": settingsPage,
};
