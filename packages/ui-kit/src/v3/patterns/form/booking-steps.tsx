// Booking «stepper»: one narrow column with three numbered steps — the service (and the specialist), the time (a strip
// of days and a grid of free times), the contacts with the consent; «Назад» and «Далее» between them, focus on the
// heading of each new step, a time taken meanwhile brings back the time step (catalog D2: no more than three steps).
// The logic is the module's: useBooking (C4) gives the services, the working days, the free times from busySlots and
// the schedule, the consent (G2-PII-04) and «booked». Own composition.
import { type BookingModel, type FormModel, useBooking, useContent } from "@wizard/ui-kit/v3/headless";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";

type Field = FormModel["fields"][number];
type Link = { label: string; href: string };

export type FormBookingStepsProps = {
  /** Entity of the bookings (publicFront.actions[].entity of useBooking; default booking). */
  entity?: string;
  /** The module's schedule and names (publicFront.actions[].booking). */
  booking: Binding;
  /** Contact field names (default: what the role may fill). */
  fields?: string[];
  /** Service field with the price (default price). */
  priceField?: string;
  /** Working days offered from today (default 14). */
  daysAhead?: number;
  title: string;
  text?: string;
  /** The action: a verb and an object (catalog K09). */
  submit: string;
  sent: { title: string; text?: string };
  /** The action of the «booked» state. */
  again?: string;
  note?: string;
  /** A direct channel when online booking cannot start. */
  contact?: Link;
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
};

const controlClass =
  "block min-h-12 w-full min-w-0 rounded-control border border-border bg-background px-4 py-2.5 text-body text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[invalid=true]:border-2 aria-[invalid=true]:border-foreground";
const primaryClass =
  "inline-flex min-h-12 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
const secondaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-inherit transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Autocomplete by the kind of personal data (catalog A09). */
const AUTOCOMPLETE: Readonly<Record<string, string>> = {
  fio: "name",
  phone: "tel",
  email: "email",
  address: "street-address",
  birthdate: "bday",
};
const NUMERIC = new Set(["int", "decimal", "money"]);

/** Ten digits of a Russian number typed in any form: 8…, +7…, spaces, brackets. */
function phoneDigits(v: string): string {
  let d = v.replace(/\D/g, "");
  if (d.length > 10 && (d.startsWith("7") || d.startsWith("8"))) d = d.slice(1);
  else if (d.length <= 10 && v.trim().startsWith("+7")) d = d.slice(1);
  return d.slice(0, 10);
}

/** The typed number as «+7 (900) 123-45-67». */
function phoneMask(v: string): string {
  const p = phoneDigits(v);
  if (!p) return "";
  let out = `+7 (${p.slice(0, 3)}`;
  if (p.length >= 3) out += ")";
  if (p.length > 3) out += ` ${p.slice(3, 6)}`;
  if (p.length > 6) out += `-${p.slice(6, 8)}`;
  if (p.length > 8) out += `-${p.slice(8, 10)}`;
  return out;
}

/** ISO time → the value of <input type=datetime-local> in the visitor's time zone. */
function localInput(v: unknown): string {
  const d = typeof v === "string" && v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The error of a field or of the consent, under it and linked by aria-describedby (catalog A03). */
function Problem({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-2 flex items-start gap-2 text-small font-bold">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        className="mt-0.5 size-4 shrink-0"
      >
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5v4.5M8 11.25v.25" strokeLinecap="round" />
      </svg>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A checkbox with a 44 px target (catalog A01): the native input, transparent, over the drawn box. */
function Check(props: {
  id: string;
  checked: boolean;
  onChange(v: boolean): void;
  invalid?: boolean;
  describedBy?: string;
}) {
  const { id, checked, onChange, invalid, describedBy } = props;
  return (
    <span className="relative -ml-2.5 flex size-11 shrink-0 items-center justify-center">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className="absolute inset-0 m-0 size-11 cursor-pointer appearance-none rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none flex size-6 items-center justify-center rounded-sm border-2 ${
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground bg-background"
        }`}
      >
        {checked ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="size-4"
          >
            <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    </span>
  );
}

/** Options of a reference field: what the role may read of the referenced list, by its name. */
function RefOptions({ entity }: { entity: string }) {
  const list = useContent(entity, { pageSize: 96 });
  return (
    <>
      {list.items.map((r) => (
        <option key={r.id} value={r.id}>
          {String(r.name ?? r.title ?? r.id)}
        </option>
      ))}
    </>
  );
}

/** One field: the label always above it, the control by the field type, the error under it. */
function FieldRow({
  field,
  form,
  uid,
  className,
}: {
  field: Field;
  form: FormModel;
  uid: string;
  className?: string;
}) {
  const id = `${uid}-${field.name}`;
  const errId = `${id}-error`;
  const error = form.errors[field.name];
  const value = form.values[field.name];
  const set = (v: unknown) => form.setValue(field.name, v);
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const aria = {
    id,
    name: field.name,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errId : undefined,
    "aria-required": field.required ? true : undefined,
  } as const;
  const label = (
    <>
      {field.label}
      {field.required ? <span className="font-normal text-muted-foreground"> · обязательно</span> : null}
    </>
  );
  if (field.type === "bool")
    return (
      <div data-testid={`wz-field-${field.name}`} className={className}>
        <div className="flex items-start gap-2">
          <Check
            id={id}
            checked={value === true}
            onChange={set}
            invalid={!!error}
            describedBy={error ? errId : undefined}
          />
          <label htmlFor={id} className="min-w-0 pt-2.5 text-body">
            {label}
          </label>
        </div>
        {error ? <Problem id={errId}>{error}</Problem> : null}
      </div>
    );
  let control: ReactNode;
  if (field.type === "text")
    control = (
      <textarea
        {...aria}
        rows={4}
        maxLength={field.maxLength}
        value={text}
        onChange={(e) => set(e.target.value)}
        className={`${controlClass} min-h-28 resize-y`}
      />
    );
  else if (field.type === "enum" || field.type === "ref")
    control = (
      <span className="relative block">
        <select
          {...aria}
          value={text}
          onChange={(e) => set(e.target.value || null)}
          className={`${controlClass} appearance-none pr-11`}
        >
          <option value="">Выберите…</option>
          {field.type === "enum" ? (
            (field.enum ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          ) : field.ref ? (
            <RefOptions entity={field.ref.entity} />
          ) : null}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  else if (field.type === "phone")
    control = (
      <input
        {...aria}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="+7 (900) 000-00-00"
        value={phoneMask(text)}
        onChange={(e) => {
          const d = phoneDigits(e.target.value);
          set(d ? `+7${d}` : "");
        }}
        className={controlClass}
      />
    );
  else if (NUMERIC.has(field.type))
    control = (
      <input
        {...aria}
        type="text"
        inputMode={field.type === "int" ? "numeric" : "decimal"}
        value={text}
        onChange={(e) => {
          const raw = e.target.value.trim();
          set(raw === "" ? null : /^-?\d+(?:[.,]\d+)?$/.test(raw) ? Number(raw.replace(",", ".")) : raw);
        }}
        className={controlClass}
      />
    );
  else if (field.type === "datetime")
    control = (
      <input
        {...aria}
        type="datetime-local"
        value={localInput(value)}
        onChange={(e) => set(e.target.value ? new Date(e.target.value).toISOString() : null)}
        className={controlClass}
      />
    );
  else
    control = (
      <input
        {...aria}
        type={
          field.type === "email"
            ? "email"
            : field.type === "url"
              ? "url"
              : field.type === "date"
                ? "date"
                : "text"
        }
        inputMode={field.type === "email" ? "email" : field.type === "url" ? "url" : undefined}
        autoComplete={
          (field.piiKind && AUTOCOMPLETE[field.piiKind]) || (field.type === "email" ? "email" : undefined)
        }
        maxLength={field.maxLength}
        value={text}
        onChange={(e) => set(e.target.value)}
        className={controlClass}
      />
    );
  return (
    <div data-testid={`wz-field-${field.name}`} className={`min-w-0 ${className ?? ""}`}>
      <label htmlFor={id} className="block text-small font-bold">
        {label}
      </label>
      <div className="mt-2">{control}</div>
      {error ? <Problem id={errId}>{error}</Problem> : null}
    </div>
  );
}

/** The personal data consent (G2-PII-04): the text and the policy page of the system, required before the write. */
function Consent({ form, uid, className }: { form: FormModel; uid: string; className?: string }) {
  const c = form.consent;
  if (!c.required) return null;
  const id = `${uid}-consent`;
  const errId = `${id}-error`;
  return (
    <div data-testid="wz-consent" className={className}>
      <div className="flex items-start gap-2">
        <Check
          id={id}
          checked={c.checked}
          onChange={c.set}
          invalid={!!c.error}
          describedBy={c.error ? errId : undefined}
        />
        <label htmlFor={id} className="min-w-0 pt-2.5 text-small text-muted-foreground">
          {c.text}
          {c.policyPage ? (
            <>
              {" "}
              в соответствии с{" "}
              <a
                href={c.policyPage}
                data-testid="wz-consent-policy-link"
                target="_blank"
                rel="noopener"
                className="text-inherit underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                политикой обработки персональных данных
              </a>
            </>
          ) : null}
        </label>
      </div>
      {c.error ? <Problem id={errId}>{c.error}</Problem> : null}
    </div>
  );
}

/** «Sent»: the answer after the write, focused and announced; the action brings an empty form back. */
function Sent({
  title,
  text,
  detail,
  again,
  onAgain,
  framed = true,
}: {
  title: string;
  text?: string;
  /** What was written, in words (a booking: the service, the day and the time). */
  detail?: string;
  again: string;
  onAgain(): void;
  /** In its own frame (false — the section already frames it). */
  framed?: boolean;
}) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    head.current?.focus();
  }, []);
  return (
    <div
      role="status"
      data-testid="booking-done"
      className={`flex items-start gap-4 ${framed ? "rounded-lg border border-border bg-card p-6 text-card-foreground sm:p-8" : ""}`}
    >
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          className="size-5"
        >
          <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0">
        <h3 ref={head} tabIndex={-1} className="font-display text-h3 font-bold text-balance outline-none">
          {title}
        </h3>
        {detail ? <p className="mt-2 text-lead font-bold">{detail}</p> : null}
        {text ? <p className="mt-2 max-w-text text-body text-muted-foreground">{text}</p> : null}
        <button type="button" onClick={onAgain} className={`mt-6 ${secondaryClass}`}>
          {again}
        </button>
      </div>
    </div>
  );
}

/** Focus after a refused submit: the first field with an error; after «again»: the first field of the new form. */
function useFormFocus(box: RefObject<HTMLFormElement | null>, tries: number, round: number) {
  useEffect(() => {
    if (tries > 0) box.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
  }, [tries, box]);
  useEffect(() => {
    if (round > 0) box.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, [round, box]);
}

/** The module's schedule and names: publicFront.actions[].booking of the backend compile (BookingFrontConfig). */
type Binding = {
  schedule: {
    tz: string;
    days: number[];
    start: number;
    end: number;
    step: number;
    breakStart: number | null;
    breakEnd: number | null;
    capacity: number;
    leadMinutes: number;
  };
  serviceEntity: string;
  durationField?: string;
  specialistEntity?: string;
  busyFn?: string;
  packageCheckFn?: string;
};
type Rec = BookingModel["services"]["items"][number];

const DAY_SHORT = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
const DAY_DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_LONG = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const MONEY = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const slotClass =
  "inline-flex min-h-12 min-w-11 items-center justify-center rounded-md border px-3 text-body font-bold tabular-nums transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** A working day (YYYY-MM-DD) as the page shows it: «пн», «12 окт.» and in full. */
function dayOf(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  const full = DAY_LONG.format(d);
  return {
    weekday: DAY_SHORT.format(d),
    date: DAY_DATE.format(d),
    full: full.charAt(0).toUpperCase() + full.slice(1),
  };
}

/** A time of the schedule in its own time zone («12:00»). */
function timeOf(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(
    new Date(iso),
  );
}

/** Name of the schedule's time zone («Москва, стандартное время»). */
function zoneOf(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: tz, timeZoneName: "long" }).formatToParts(
      new Date(),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

const nameOf = (r: Rec | null): string => (r ? String(r.name ?? r.title ?? "") : "");

/** Length and price of a service, only from the data (catalog R04: no «от» of our own). */
function metaOf(r: Rec, durationField: string | undefined, priceField: string): string {
  const out: string[] = [];
  const min = durationField ? r[durationField] : undefined;
  if (typeof min === "number" && min > 0) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    // Minutes below two hours («60 мин», «90 мин») as the catalog of the module shows them, then hours.
    out.push(min < 120 ? `${min} мин` : m ? `${h} ч ${m} мин` : `${h} ч`);
  }
  const price = r[priceField];
  if (typeof price === "number" && Number.isFinite(price)) out.push(MONEY.format(price));
  return out.join(" · ");
}

/** useBooking over the props: the module's schedule and names; ?service= of a showcase link preselects the service. */
function useBookingOf(p: {
  entity?: string;
  booking: Binding;
  fields?: string[];
  daysAhead?: number;
}): BookingModel {
  const [preset] = useState(() =>
    typeof location === "undefined" ? null : new URLSearchParams(location.search).get("service"),
  );
  const b = p.booking;
  return useBooking({
    schedule: b.schedule,
    entity: p.entity ?? "booking",
    serviceEntity: b.serviceEntity,
    ...(b.durationField ? { durationField: b.durationField } : {}),
    ...(b.specialistEntity ? { specialistEntity: b.specialistEntity } : {}),
    ...(b.busyFn ? { busyFn: b.busyFn } : {}),
    ...(b.packageCheckFn ? { packageCheckFn: b.packageCheckFn } : {}),
    ...(p.fields ? { fields: p.fields } : {}),
    ...(p.daysAhead ? { daysAhead: p.daysAhead } : {}),
    ...(preset ? { service: preset } : {}),
  });
}

/** Loading of the services (catalog A04): the outline of the choice, announced once. */
function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Загружаем услуги…</span>
      <div aria-hidden="true" className="grid gap-3">
        {["a", "b", "c"].map((k) => (
          <div key={k} className="h-14 rounded-md bg-muted" />
        ))}
      </div>
    </div>
  );
}

/** Why a booking cannot start — no right to book, the services did not load, there are none — and a direct channel. */
function Blocked({ m, contact }: { m: BookingModel; contact?: Link }) {
  const failed = !!m.services.error;
  const say = !m.allowed
    ? "Онлайн-запись сейчас недоступна."
    : failed
      ? "Не получилось загрузить услуги. Обновите страницу чуть позже."
      : "Пока нет услуг для онлайн-записи.";
  return (
    <div role={failed ? "alert" : undefined} className="rounded-lg border border-border p-6 sm:p-8">
      <p className="text-body font-bold">{say}</p>
      {contact ? (
        <p className="mt-2 text-body text-muted-foreground">
          Записаться можно напрямую:{" "}
          <a
            href={contact.href}
            className="inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {contact.label}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** The booking cannot start (no right, no services, a load error) — Blocked shows why. */
const blocked = (m: BookingModel) =>
  !m.allowed || !!m.services.error || (!m.services.isLoading && m.services.items.length === 0);

/** Free times of the chosen day as pressed buttons (≥ 48 px, catalog D1 SlotCalendar) with every state in words. */
function Times({ m, tz, className }: { m: BookingModel; tz: string; className: string }) {
  let body: ReactNode;
  if (!m.ready)
    body = (
      <p className="text-body text-muted-foreground">
        {m.specialists
          ? "Выберите услугу и специалиста — покажем свободное время."
          : "Выберите услугу — покажем свободное время."}
      </p>
    );
  else if (m.slotsLoading)
    body = (
      <p role="status" className="text-body text-muted-foreground">
        Ищем свободное время…
      </p>
    );
  else if (m.slotsError)
    body = (
      <p role="alert" className="text-body font-bold">
        Не получилось получить свободное время. Выберите другой день или обновите страницу.
      </p>
    );
  else if (m.slots.length === 0)
    body = (
      <p data-testid="wz-empty" className="text-body text-muted-foreground">
        На этот день свободного времени нет — выберите другой день.
      </p>
    );
  else
    body = (
      <fieldset>
        <legend className="sr-only">{`Свободное время: ${dayOf(m.day).full}`}</legend>
        <div data-testid="booking-slots" className={className}>
          {m.slots.map((s) => {
            const on = m.slot?.start === s.start;
            return (
              <button
                key={s.start}
                type="button"
                aria-pressed={on}
                onClick={() => m.selectSlot(on ? null : s)}
                className={`${slotClass} ${on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:border-muted-foreground"}`}
              >
                {timeOf(s.start, tz)}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-small text-muted-foreground">{`Время указано: ${zoneOf(tz)}`}</p>
      </fieldset>
    );
  return (
    <div data-testid="booking-time" aria-busy={m.slotsLoading ? true : undefined}>
      {m.notice ? (
        <p role="alert" className="mb-4 text-body font-bold">
          {m.notice}
        </p>
      ) : null}
      {body}
    </div>
  );
}

/** The contacts of the booking with the consent and the action; focus goes to the first error of a refused write. */
function Contacts({ m, uid, submit, note }: { m: BookingModel; uid: string; submit: string; note?: string }) {
  const box = useRef<HTMLFormElement>(null);
  const [tries, setTries] = useState(0);
  useFormFocus(box, tries, 0);
  const form = m.form;
  const shown = form.fields.filter((f) => f.type !== "image" && f.type !== "file");
  // Two columns from sm: long texts and checkboxes take the row, and so does an odd last field.
  const wide = (f: Field) => f.type === "text" || f.type === "bool";
  const halves = shown.filter((f) => !wide(f));
  const span = (f: Field) => wide(f) || (halves.length % 2 === 1 && f === halves[halves.length - 1]);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!(await form.submit())) setTries((n) => n + 1);
  };
  return (
    <form
      ref={box}
      data-testid="booking-form"
      noValidate
      onSubmit={onSubmit}
      aria-label="Контакты для записи"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {shown.map((f) => (
          <FieldRow key={f.name} field={f} form={form} uid={uid} className={span(f) ? "sm:col-span-2" : ""} />
        ))}
        <Consent form={form} uid={uid} className="sm:col-span-2" />
      </div>
      {form.formError ? (
        <p role="alert" className="mt-5 text-body font-bold">
          {form.formError}
        </p>
      ) : null}
      <button
        type="submit"
        aria-disabled={form.pending ? true : undefined}
        className={`mt-6 w-full sm:w-auto ${primaryClass}`}
      >
        {form.pending ? "Записываем…" : submit}
      </button>
      {note ? <p className="mt-4 text-small text-muted-foreground">{note}</p> : null}
    </form>
  );
}

/** What was booked, in words: the service, the day and the time. */
function bookedText(m: BookingModel, tz: string): string {
  const b = m.booked;
  return b ? [nameOf(m.service), dayOf(m.day).full, timeOf(b.start, tz)].filter(Boolean).join(", ") : "";
}

/** «Again» after a booking: the choice of time comes back and gets the focus. */
function useAgain(m: BookingModel, target: RefObject<HTMLElement | null>) {
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (round > 0) target.current?.focus();
  }, [round, target]);
  return () => {
    m.again();
    setRound((r) => r + 1);
  };
}

/** Services or specialists as cards of a radio group: the whole card is the target, the choice is drawn by state. */
function Choice(props: {
  uid: string;
  name: string;
  legend: string;
  items: Rec[];
  value: string | null;
  onChange(id: string): void;
  describe?(r: Rec): string;
  /** Columns of the cards (Tailwind grid classes; default one column). */
  columns?: string;
}) {
  const { uid, name, legend, items, value, onChange, describe, columns = "" } = props;
  return (
    <fieldset data-testid={`booking-${name}`} className="min-w-0">
      <legend className="text-small font-bold">{legend}</legend>
      <div className={`mt-3 grid gap-3 ${columns}`}>
        {items.map((r) => {
          const on = value === r.id;
          const info = describe?.(r);
          return (
            <label
              key={r.id}
              className={`relative flex min-h-14 cursor-pointer items-center justify-between gap-4 rounded-md border bg-background px-4 py-3 text-foreground transition-colors duration-200 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring ${
                on ? "border-primary ring-1 ring-primary" : "border-border hover:border-muted-foreground"
              }`}
            >
              <input
                type="radio"
                name={`${uid}-${name}`}
                value={r.id}
                checked={on}
                onChange={() => onChange(r.id)}
                className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-md"
              />
              <span className="min-w-0">
                <span className="block font-bold wrap-break-word">{nameOf(r)}</span>
                {info ? <span className="mt-0.5 block text-small text-muted-foreground">{info}</span> : null}
              </span>
              <span
                aria-hidden="true"
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  on ? "border-primary" : "border-muted-foreground"
                }`}
              >
                {on ? <span className="size-2.5 rounded-full bg-primary" /> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Working days as a strip of pressed buttons; on phones the strip scrolls sideways under the finger. */
function DayStrip({ m }: { m: BookingModel }) {
  return (
    <fieldset data-testid="booking-day" className="min-w-0">
      <legend className="text-small font-bold">День</legend>
      <div className="mt-3 -mb-2 overflow-x-auto pb-2">
        <div className="flex w-max gap-2">
          {m.days.map((d) => {
            const x = dayOf(d);
            const on = m.day === d;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => m.selectDay(d)}
                className={`flex min-h-16 min-w-16 flex-col items-center justify-center rounded-md border px-3 text-center transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:border-muted-foreground"
                }`}
              >
                <span className="text-small">{x.weekday}</span>
                <span className="font-bold whitespace-nowrap">{x.date}</span>
              </button>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}

const STEPS = ["Услуга", "Время", "Контакты"] as const;

export default function FormBookingSteps(props: FormBookingStepsProps) {
  const { booking, priceField = "price", title, text, submit, sent, again, note, contact } = props;
  const m = useBookingOf(props);
  const uid = useId();
  const tz = booking.schedule.tz;
  const head = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  const [moved, setMoved] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const loading = m.services.isLoading || !!m.specialists?.isLoading;
  const go = (to: number) => {
    setStep(to);
    setHint(null);
    setMoved((n) => n + 1);
  };
  const onAgain = useAgain(m, head);
  useEffect(() => {
    if (moved > 0) head.current?.focus();
  }, [moved]);
  // A time taken meanwhile clears the choice: back to the times, where the notice is.
  useEffect(() => {
    if (step === 2 && !m.slot && !m.booked) go(1);
  });
  const next = () => {
    if (step === 0 && !m.ready) setHint(m.specialists ? "Выберите услугу и специалиста" : "Выберите услугу");
    else if (step === 1 && !m.slot) setHint("Выберите свободное время");
    else go(step + 1);
  };
  let body: ReactNode;
  if (m.booked)
    body = (
      <Sent
        title={sent.title}
        detail={bookedText(m, tz)}
        text={sent.text}
        again={again ?? "Записаться ещё раз"}
        onAgain={() => {
          setStep(1);
          onAgain();
        }}
      />
    );
  else if (blocked(m)) body = <Blocked m={m} contact={contact} />;
  else
    body = (
      <div className="rounded-lg border border-border bg-card p-6 text-card-foreground sm:p-10">
        <h3 ref={head} tabIndex={-1} className="font-display text-h3 font-bold outline-none">
          <span className="block font-sans text-small font-normal text-muted-foreground">{`Шаг ${step + 1} из ${STEPS.length}`}</span>
          {step === 0 ? "Выберите услугу" : step === 1 ? "Выберите день и время" : "Оставьте контакты"}
        </h3>
        {step > 0 ? (
          <p className="mt-2 text-body text-muted-foreground">
            {[
              nameOf(m.service),
              m.specialist ? nameOf(m.specialist) : "",
              step === 2 && m.slot ? `${dayOf(m.day).full}, ${timeOf(m.slot.start, tz)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
        <div aria-busy={loading ? true : undefined} className="mt-6 space-y-8">
          {step === 0 ? (
            loading ? (
              <Loading />
            ) : (
              <>
                <Choice
                  uid={uid}
                  name="service"
                  legend="Услуга"
                  items={m.services.items}
                  value={m.service?.id ?? null}
                  onChange={m.selectService}
                  describe={(r) => metaOf(r, booking.durationField, priceField)}
                />
                {m.specialists ? (
                  <Choice
                    uid={uid}
                    name="specialist"
                    legend="Специалист"
                    items={m.specialists.items}
                    value={m.specialist?.id ?? null}
                    onChange={m.selectSpecialist}
                  />
                ) : null}
              </>
            )
          ) : step === 1 ? (
            <>
              <DayStrip m={m} />
              <Times m={m} tz={tz} className="grid grid-cols-3 gap-2 sm:grid-cols-5" />
            </>
          ) : (
            <Contacts m={m} uid={uid} submit={submit} note={note} />
          )}
        </div>
        {hint ? (
          <p role="alert" className="mt-6 text-body font-bold">
            {hint}
          </p>
        ) : null}
        <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
          {step > 0 ? (
            <button type="button" onClick={() => go(step - 1)} className={secondaryClass}>
              Назад
            </button>
          ) : null}
          {step < 2 ? (
            <button
              type="button"
              data-testid="booking-next"
              onClick={next}
              className={`sm:ml-auto ${primaryClass}`}
            >
              Далее
            </button>
          ) : null}
        </div>
      </div>
    );
  return (
    <section
      data-wz-component="BookingForm"
      data-wz-id={props.wzId}
      data-testid="booking-page"
      aria-labelledby={`${uid}-title`}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-3xl px-gutter">
        <h2 id={`${uid}-title`} className="font-display text-h2 font-bold text-balance wrap-break-word">
          {title}
        </h2>
        {text ? <p className="mt-3 text-body text-muted-foreground">{text}</p> : null}
        {!m.booked && !blocked(m) ? (
          <ol className="mt-8 grid grid-cols-3 gap-2">
            {STEPS.map((s, i) => (
              <li key={s} aria-current={i === step ? "step" : undefined} className="min-w-0">
                <span
                  aria-hidden="true"
                  className={`block h-1 rounded-full ${i <= step ? "bg-primary" : "bg-border"}`}
                />
                <span
                  className={`mt-2 block text-small ${i === step ? "font-bold text-foreground" : "text-muted-foreground"}`}
                >
                  {`${i + 1}. ${s}`}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="mt-6">{body}</div>
      </div>
    </section>
  );
}
