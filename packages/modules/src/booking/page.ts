// The public page /booking of «Запись по слотам» (screen generator): service → resource → day → free time → name and
// contacts with consent → «Вы записаны». Free times come from busySlots (start, end and seat of occupied bookings) and
// the schedule compiled into the page; the booking itself is a plain create through the data API — one time, one
// booking per resource and seat by the unique index, so a second visitor on the same time gets CONFLICT (D75).
// With ?reschedule=<token> (the runtime's one-time link from the e-mail, B2-14) the same picker links to
// /_wizard/hooks/message/reschedule/<token>?starts_at=…: the runtime confirms the new time and moves the booking once
// (generated pages may not post forms elsewhere, G0-SEC-01). With «Абонементы и пакеты» (B2-18) the form first asks
// packageCheck whether the contacts have a valid package on the day of the visit and does not book without one.
import type { Field } from "@wizard/appspec";
import { js } from "../screens/jsx.js";
import type { ScreenContext } from "../types.js";
import { linkRules, SERVICE_CONTRACT } from "./compile.js";
import { scheduleOf, scheduleSource } from "./schedule.js";

const RESCHEDULE_PATH = "/_wizard/hooks/message/reschedule/";

interface FormField {
  name: string;
  label: string;
  type: Field["type"];
  required: boolean;
  options?: { value: string; label: string }[];
}

/** Visitor fields of the form: name and contacts, then the plan's extra fields (images are filled in the cabinet). */
function formFields(ctx: ScreenContext): FormField[] {
  const e = ctx.spec.entities.find((x) => x.name === "booking");
  const extra = ((ctx.params.extra_fields as { name: string }[] | undefined) ?? []).map((f) => f.name);
  const names = ["name", "phone", "email", "comment", ...extra];
  return names.flatMap((n) => {
    const f = e?.fields.find((x) => x.name === n);
    if (!f || f.type === "image") return [];
    return [
      {
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required === true,
        ...(f.enum ? { options: f.enum.map((o) => ({ value: o.value, label: o.label })) } : {}),
      },
    ];
  });
}

export function bookingPage(ctx: ScreenContext): string {
  const p = ctx.params;
  const spec = p.with_specialists === true;
  const capacity = typeof p.capacity === "number" ? p.capacity : 1;
  const manual = p.confirm === "manual";
  const links = linkRules(p);
  // «Абонементы и пакеты» (B2-18): a booking takes a visit off a valid package; the page asks packageCheck first.
  const pkgParams = ctx.allParams.packages;
  const byPackage = ctx.present.has("packages") && pkgParams?.write_off_on_booking !== false;
  const pkgLabel = String(pkgParams?.package_label ?? "Абонемент").toLowerCase();
  const pkgName = pkgLabel === "абонемент" ? "абонемент" : `«${pkgLabel}»`;
  const consentField = ctx.spec.entities
    .find((x) => x.name === "booking")
    ?.fields.find((f) => f.name === "consent_messages");
  const text = {
    title: "Запись",
    rescheduleTitle: "Перенос записи",
    rescheduleIntro: "Выберите новый день и время — старое время освободится.",
    service: "Услуга",
    specialist: String(p.specialist_label ?? "Специалист"),
    day: "День",
    time: "Время",
    noServices: "Пока нет услуг для записи",
    noSpecialists: "Пока некого выбрать — загляните позже",
    pickFirst: spec ? "Сначала выберите услугу и специалиста" : "Сначала выберите услугу",
    noTime: "На этот день свободного времени нет — выберите другой день",
    minutes: "мин",
    contacts: "Ваши данные",
    submit: manual ? "Отправить заявку на запись" : "Записаться",
    moveSubmit: "Перенести на это время",
    required: "Обязательное поле",
    consent: "Без согласия на обработку данных записаться нельзя",
    taken: "Это время только что заняли — выберите другое",
    failed: "Не получилось записаться. Попробуйте ещё раз",
    doneTitle: manual ? "Заявка на запись отправлена" : "Вы записаны",
    doneText: manual
      ? "Мы подтвердим запись письмом."
      : links.any
        ? "Если вы согласились на письма, подтверждение со ссылками для отмены и переноса придёт на почту."
        : "Ждём вас!",
    again: "Записаться ещё раз",
    chosen: "Выбрано",
    ...(byPackage
      ? {
          byPackage: `Запись — по ${pkgName === "абонемент" ? "абонементу" : pkgName}: укажите телефон и почту, на которые он оформлен. Визит спишется с него.`,
          noPackage: `На эти телефон и почту нет действующего ${pkgName === "абонемент" ? "абонемента" : pkgName} на день визита. Продлите его у администратора или проверьте данные.`,
        }
      : {}),
  };
  const form = formFields(ctx);
  // The length of a booking: the service's duration (catalog with_duration), else one step of the schedule.
  const duration = ctx.spec.entities
    .find((x) => x.name === SERVICE_CONTRACT.entity)
    ?.fields.some((f) => f.name === SERVICE_CONTRACT.duration)
    ? SERVICE_CONTRACT.duration
    : null;
  const minutesOf = (v: string) => (duration ? `${v}.${duration} ?? null` : "null");
  const schedule = scheduleOf(p);
  const busyArgs = `{ from: new Date(zonedAt(day, 0)).toISOString(), to: new Date(zonedAt(addDays(day, 1), 0)).toISOString()${spec ? ', specialist: specialist as Id<"specialist">' : ""} }`;

  return `// Generated by the module «Запись по слотам» (B2-14): service → ${spec ? "resource → " : ""}day → free time → contacts with consent.
// A booking is a plain create (one time — one booking per ${spec ? "resource and " : ""}seat by a unique index → CONFLICT);
// ?reschedule=<token> moves a booking through the runtime's one-time link (a plain HTML form post).
import { type Id, type Insert, useEntityList, useEntityMutation, useMemo, ${byPackage ? "useMutation, " : ""}useQuery, useState } from "@wizard/sdk";
import { Button, ConsentCheckbox, EmptyState, Field, type FieldType, Loading, useLocation } from "@wizard/ui-kit";

${scheduleSource(schedule)}
const TEXT = ${js(text)};
type FormField = { name: string; label: string; type: FieldType; required: boolean; options?: { value: string; label: string }[] };
const FORM: FormField[] = ${js(form)};
${consentField ? `const CONSENT_MESSAGES = ${js(consentField.label)};\n` : ""}const RESCHEDULE_PATH = ${js(RESCHEDULE_PATH)};
const DAYS_AHEAD = 14;

const timeFormat = new Intl.DateTimeFormat("ru-RU", { timeZone: SCHEDULE.tz, hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const whenFormat = new Intl.DateTimeFormat("ru-RU", {
  timeZone: SCHEDULE.tz,
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});
const row = { display: "flex", flexWrap: "wrap", gap: 8 } as const;

/** The runtime's confirmation of the move (the one-time link of the e-mail with the new time in the query). */
function moveLink(token: string, slot: FreeSlot): string {
  const q = new URLSearchParams({ starts_at: slot.start, ends_at: slot.end${capacity > 1 ? ", seat: String(slot.seat)" : ""} });
  return \`\${RESCHEDULE_PATH}\${encodeURIComponent(token)}?\${q.toString()}\`;
}

export default function BookingPage() {
  const { search } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const token = params.get("reschedule");
  const [service, setService] = useState<string | null>(params.get("service"));${
    spec ? `\n  const [specialist, setSpecialist] = useState<string | null>(params.get("specialist"));` : ""
  }
  const days = useMemo(() => workdays(dayKey(Date.now()), DAYS_AHEAD), []);
  const [day, setDay] = useState<string>(days[0] ?? dayKey(Date.now()));
  const [slot, setSlot] = useState<FreeSlot | null>(null);
  const [booked, setBooked] = useState<FreeSlot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const services = useEntityList("service", { filter: { active: true }, sort: "name", limit: 100 });${
    spec
      ? `\n  const specialists = useEntityList("specialist", { filter: { active: true }, sort: "name", limit: 100 });`
      : ""
  }
  const chosen = services.items.find((s) => s.id === service) ?? null;
  const ready = chosen !== null${spec ? " && specialist !== null" : ""};
  const busy = useQuery("busySlots", ready ? ${busyArgs} : "skip");
  const free = useMemo(
    () => (busy.data && chosen ? freeSlots(day, ${minutesOf("chosen")}, busy.data, Date.now()) : []),
    [busy.data, chosen, day],
  );

  if (booked)
    return (
      <main data-testid="booking-done">
        <h1>{TEXT.doneTitle}</h1>
        <p>{whenFormat.format(new Date(booked.start))}{chosen ? \` — \${chosen.name}\` : ""}</p>
        <p>{TEXT.doneText}</p>
        <Button variant="secondary" onClick={() => { setBooked(null); setSlot(null); }}>{TEXT.again}</Button>
      </main>
    );

  return (
    <main data-testid="booking-page">
      <h1>{token ? TEXT.rescheduleTitle : TEXT.title}</h1>
      {token ? <p>{TEXT.rescheduleIntro}</p> : null}
      <section aria-label={TEXT.service}>
        <h2>{TEXT.service}</h2>
        {services.isLoading ? (
          <Loading />
        ) : services.items.length === 0 ? (
          <EmptyState text={TEXT.noServices} />
        ) : token && chosen ? (
          <p>{chosen.name}</p>
        ) : (
          <div style={row}>
            {services.items.map((s) => (
              <Button
                key={s.id}
                variant={s.id === service ? "primary" : "secondary"}
                aria-pressed={s.id === service}
                onClick={() => { setService(s.id); setSlot(null); }}
              >
                {${duration ? `s.${duration} ? \`\${s.name} · \${s.${duration}} \${TEXT.minutes}\` : s.name` : "s.name"}}
              </Button>
            ))}
          </div>
        )}
      </section>${
        spec
          ? `
      <section aria-label={TEXT.specialist}>
        <h2>{TEXT.specialist}</h2>
        {specialists.isLoading ? (
          <Loading />
        ) : specialists.items.length === 0 ? (
          <EmptyState text={TEXT.noSpecialists} />
        ) : token ? (
          <p>{specialists.items.find((x) => x.id === specialist)?.name ?? ""}</p>
        ) : (
          <div style={row}>
            {specialists.items.map((x) => (
              <Button
                key={x.id}
                variant={x.id === specialist ? "primary" : "secondary"}
                aria-pressed={x.id === specialist}
                onClick={() => { setSpecialist(x.id); setSlot(null); }}
              >
                {x.name}
              </Button>
            ))}
          </div>
        )}
      </section>`
          : ""
      }
      <section aria-label={TEXT.day}>
        <h2>{TEXT.day}</h2>
        <div style={row}>
          {days.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === day ? "primary" : "secondary"}
              aria-pressed={d === day}
              onClick={() => { setDay(d); setSlot(null); }}
            >
              {dayFormat.format(new Date(\`\${d}T12:00:00Z\`))}
            </Button>
          ))}
        </div>
      </section>
      <section aria-label={TEXT.time}>
        <h2>{TEXT.time}</h2>
        {notice ? <p role="alert">{notice}</p> : null}
        {!ready ? (
          <p>{TEXT.pickFirst}</p>
        ) : busy.isLoading ? (
          <Loading />
        ) : free.length === 0 ? (
          <EmptyState text={TEXT.noTime} />
        ) : (
          <div style={row} data-testid="booking-slots">
            {free.map((s) => (
              <Button
                key={s.start}
                size="sm"
                variant={slot?.start === s.start ? "primary" : "secondary"}
                aria-pressed={slot?.start === s.start}
                onClick={() => { setSlot(s); setNotice(null); }}
              >
                {timeFormat.format(new Date(s.start))}
              </Button>
            ))}
          </div>
        )}
      </section>
      {slot && chosen ? (
        token ? (
          <section aria-label={TEXT.moveSubmit} data-testid="booking-move">
            <p>{TEXT.chosen}: {whenFormat.format(new Date(slot.start))}</p>
            <Button variant="primary" href={moveLink(token, slot)}>{TEXT.moveSubmit}</Button>
          </section>
        ) : (
          <BookingForm
            service={chosen.id}${spec ? '\n            specialist={specialist ?? ""}' : ""}
            slot={slot}
            onDone={() => setBooked(slot)}
            onTaken={() => { setSlot(null); setNotice(TEXT.taken); busy.refetch(); }}
          />
        )
      ) : null}
    </main>
  );
}

function BookingForm(props: {
  service: string;${spec ? "\n  specialist: string;" : ""}
  slot: FreeSlot;
  onDone(): void;
  onTaken(): void;
}) {
  const mutations = useEntityMutation("booking");
${byPackage ? '  const [checkPackage] = useMutation("packageCheck");\n' : ""}  const [values, setValues] = useState<Record<string, unknown>>({});
${consentField ? "  const [messages, setMessages] = useState(false);\n" : ""}  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [consentError, setConsentError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const missing: Record<string, string> = {};
    for (const f of FORM) {
      const v = values[f.name];
      if (f.required && (v === undefined || v === null || v === "")) missing[f.name] = TEXT.required;
    }
    setErrors(missing);
    setConsentError(consent ? undefined : TEXT.consent);
    if (Object.keys(missing).length > 0 || !consent) return;
    const doc: Record<string, unknown> = {
      service: props.service,${spec ? "\n      specialist: props.specialist," : ""}
      starts_at: props.slot.start,
      ends_at: props.slot.end,${capacity > 1 ? "\n      seat: props.slot.seat," : ""}
${consentField ? "      consent_messages: messages,\n" : ""}    };
    for (const f of FORM) {
      const v = values[f.name];
      if (v !== undefined && v !== null && v !== "") doc[f.name] = v;
    }
    setPending(true);
    setError(null);
    try {
${
  byPackage
    ? `      // A valid package on the day of the visit for these contacts (yes or no): without one the visitor does not book.
      const found = await checkPackage({
        phone: String(doc.phone ?? ""),
        ...(typeof doc.email === "string" && doc.email !== "" ? { email: doc.email } : {}),
        starts_at: props.slot.start,
      });
      if (!found.ok) {
        setError(TEXT.noPackage);
        return;
      }
`
    : ""
}      await mutations.create(doc as unknown as Insert<"booking">, { consent: true });
      props.onDone();
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: { fields?: { field: string; message: string }[] } };
      if (err.code === "CONFLICT") {
        props.onTaken();
        return;
      }
      const byField: Record<string, string> = {};
      for (const x of err.details?.fields ?? []) byField[x.field] = x.message;
      setErrors(byField);
      setError(err.message ?? TEXT.failed);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-testid="booking-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>{TEXT.contacts}</h2>${byPackage ? "\n      <p>{TEXT.byPackage}</p>" : ""}
      {FORM.map((f) => (
        <Field
          key={f.name}
          name={f.name}
          label={f.label}
          type={f.type}
          required={f.required}
          value={values[f.name] ?? null}
          error={errors[f.name]}
          enumOptions={f.options}
          onChange={(v: unknown) => setValues((o) => ({ ...o, [f.name]: v }))}
        />
      ))}
${
  consentField
    ? `      <Field
        name="consent_messages"
        label={CONSENT_MESSAGES}
        type="bool"
        value={messages}
        onChange={(v: unknown) => setMessages(v === true)}
      />
`
    : ""
}      <ConsentCheckbox checked={consent} onChange={setConsent} error={consentError} />
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" variant="primary" loading={pending}>
        {TEXT.submit}
      </Button>
    </form>
  );
}
`;
}
