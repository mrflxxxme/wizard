// useBooking (V3-10, C4): booking by slots on a v3 page without markup — the logic of the v2 booking page of the module
// «Запись по слотам»: service (→ specialist) → day → free time from busySlots and the module's schedule → contacts with
// the personal data consent (G2-PII-04) → a plain create of the booking; a time taken meanwhile (CONFLICT of the unique
// time-and-seat index) clears the choice and refreshes the free times; with packages, packageCheck before the write.
import { useMemo, useState } from "react";
import { useCan, useDataSource, useRoleSpec } from "../../data/context.js";
import type { Rec, WzError } from "../../data/types.js";
import { defaultFormFields, type FormModel, useFormModel } from "./form.js";
import {
  addDays,
  type BusyTime,
  dayKey,
  type FreeSlot,
  freeSlots,
  type ScheduleSpec,
  workdays,
  zonedAt,
} from "./schedule.js";

/** Russian messages of the booking (the texts of the v2 page). */
export const BOOKING_TEXTS = {
  taken: "Это время только что заняли — выберите другое",
  noPackage:
    "На эти телефон и почту нет действующего абонемента на день визита. Продлите его у администратора или проверьте данные.",
  rescheduleTitle: "Перенос записи",
  rescheduleIntro: "Выберите новый день и время — старое время освободится.",
  moveSubmit: "Перенести на это время",
  chosen: "Выбрано",
} as const;

/** The runtime's one-time link of the reschedule (B2-14): the page links back to it with the new time in the query. */
export const RESCHEDULE_PATH = "/_wizard/hooks/message/reschedule/";

/** What the address of the booking page carries: ?service= of a showcase link; ?reschedule= of the e-mail's link. */
export interface BookingAddress {
  service: string | null;
  specialist: string | null;
  /** The one-time token of the reschedule link (the runtime redirects here with it and the kept service). */
  reschedule: string | null;
}

/** The booking parameters of a query string (default: the page's address). */
export function bookingAddress(search?: string): BookingAddress {
  const q = new URLSearchParams(search ?? (typeof location === "undefined" ? "" : location.search));
  return { service: q.get("service"), specialist: q.get("specialist"), reschedule: q.get("reschedule") };
}

export interface UseBookingOptions {
  /** The module's schedule (publicFront.actions[].booking.schedule of the backend compile). */
  schedule: ScheduleSpec;
  /** Booking entity (default booking). */
  entity?: string;
  /** Services to book (default service, visible ones by name). */
  serviceEntity?: string;
  serviceFilter?: Readonly<Record<string, unknown>>;
  /** Service field with the booking length in minutes (default: one step of the schedule). */
  durationField?: string;
  /** Resource the visitor picks (with_specialists): active ones by name. */
  specialistEntity?: string;
  /** Public query of the busy times (default busySlots). */
  busyFn?: string;
  /** Contact fields (default: what the role may fill, without the chosen time and images). */
  fields?: readonly string[];
  /** Package check before the write (B2-18, packages with write_off_on_booking): its function name. */
  packageCheckFn?: string;
  /** Days offered from today (default 14 working days). */
  daysAhead?: number;
  /** Clock (tests). */
  now?: () => number;
  /** Preselected service and specialist (e.g. ?service= of a showcase link). */
  service?: string | null;
  specialist?: string | null;
  /**
   * The token of the e-mail's reschedule link (?reschedule=, B2-14): the service and specialist the runtime kept stay
   * fixed, the chosen time goes to the runtime's confirmation instead of the contacts — exactly as the v2 page.
   */
  reschedule?: string | null;
  texts?: Partial<Record<keyof typeof BOOKING_TEXTS, string>>;
}

/** A reschedule by the e-mail's link: the texts of the page and the confirmation address of a chosen time. */
export interface BookingReschedule {
  token: string;
  title: string;
  intro: string;
  /** Label of the link to the confirmation («Перенести на это время»). */
  submit: string;
  /** «Выбрано». */
  chosen: string;
  /** The runtime's confirmation of the new time: /_wizard/hooks/message/reschedule/<token>?starts_at=…&ends_at=… */
  href(slot: FreeSlot): string;
}

export interface BookingList {
  items: Rec[];
  isLoading: boolean;
  error?: WzError;
}

export interface BookingModel {
  /** The role may create a booking. */
  allowed: boolean;
  services: BookingList;
  service: Rec | null;
  selectService(id: string | null): void;
  /** Specialists (with specialistEntity), else null. */
  specialists: BookingList | null;
  specialist: Rec | null;
  selectSpecialist(id: string | null): void;
  days: string[];
  day: string;
  selectDay(day: string): void;
  /** A service (and a specialist) is chosen: the free times are asked. */
  ready: boolean;
  slots: FreeSlot[];
  slotsLoading: boolean;
  slotsError?: WzError;
  slot: FreeSlot | null;
  selectSlot(slot: FreeSlot | null): void;
  /** A notice about the time (taken meanwhile), null otherwise. */
  notice: string | null;
  /** Contacts and consent; submit() writes the booking of the chosen time. */
  form: FormModel;
  /** The booked time after a successful write. */
  booked: FreeSlot | null;
  /** Start again after «Вы записаны». */
  again(): void;
  /** A reschedule by the e-mail's link (?reschedule=), else null. */
  reschedule: BookingReschedule | null;
  /** The service (and specialist) are fixed: the reschedule keeps the booked ones — show them, offer no choice. */
  fixed: boolean;
}

const byName = { field: "name", dir: "asc" as const };

/** Booking over the DataSource of the WzProvider (@wizard/sdk by default). */
export function useBooking(o: UseBookingOptions): BookingModel {
  const spec = useRoleSpec();
  const ds = useDataSource();
  const can = useCan();
  const s = o.schedule;
  const now = o.now ?? Date.now;
  const entity = o.entity ?? "booking";
  const texts = { ...BOOKING_TEXTS, ...o.texts };
  const [service, setService] = useState<string | null>(o.service ?? null);
  const [specialist, setSpecialist] = useState<string | null>(o.specialist ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the offered days are fixed when the page opens
  const days = useMemo(() => workdays(s, dayKey(s.tz, now()), o.daysAhead ?? 14), []);
  const [day, setDay] = useState<string>(days[0] ?? dayKey(s.tz, now()));
  const [slot, setSlot] = useState<FreeSlot | null>(null);
  const [booked, setBooked] = useState<FreeSlot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const serviceQuery = { filter: { ...(o.serviceFilter ?? { active: true }) }, sort: byName, pageSize: 100 };
  const services = ds.useList<Rec>(o.serviceEntity ?? "service", serviceQuery);
  // Without specialists the same query as the services: one request, no extra entity.
  const specialists = ds.useList<Rec>(
    o.specialistEntity ?? o.serviceEntity ?? "service",
    o.specialistEntity ? { filter: { active: true }, sort: byName, pageSize: 100 } : serviceQuery,
  );
  const chosen = services.data?.items.find((x) => x.id === service) ?? null;
  const who = o.specialistEntity ? (specialists.data?.items.find((x) => x.id === specialist) ?? null) : null;
  const ready = chosen !== null && (!o.specialistEntity || who !== null);
  const busy = ds.useFn<BusyTime[]>(
    o.busyFn ?? "busySlots",
    ready
      ? {
          from: new Date(zonedAt(s.tz, day, 0)).toISOString(),
          to: new Date(zonedAt(s.tz, addDays(day, 1), 0)).toISOString(),
          ...(o.specialistEntity ? { specialist } : {}),
        }
      : "skip",
  );
  const minutes =
    o.durationField && typeof chosen?.[o.durationField] === "number"
      ? (chosen[o.durationField] as number)
      : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: free times follow the busy times, the service and the day
  const slots = useMemo(
    () => (ready && Array.isArray(busy.data) ? freeSlots(s, day, minutes, busy.data, now()) : []),
    [busy.data, ready, day, minutes],
  );

  const call = ds.useCall<{ ok: boolean }>();
  const hidden: Record<string, unknown> = {
    ...(chosen ? { service: chosen.id } : {}),
    ...(o.specialistEntity && specialist ? { specialist } : {}),
    ...(slot
      ? { starts_at: slot.start, ends_at: slot.end, ...(s.capacity > 1 ? { seat: slot.seat } : {}) }
      : {}),
  };
  const fields = (o.fields ?? defaultFormFields(spec, entity)).filter((n) => {
    const f = spec.entities.find((e) => e.name === entity)?.fields.find((x) => x.name === n);
    return f && f.type !== "image" && !["service", "specialist", "starts_at", "ends_at", "seat"].includes(n);
  });
  const form = useFormModel({
    entity,
    mode: "create",
    fields,
    hidden,
    initial: {},
    onSuccess: () => setBooked(slot),
    onError: (e) => {
      if (e.code !== "CONFLICT") return false;
      setSlot(null);
      setNotice(texts.taken);
      busy.refetch();
      return true;
    },
    ...(o.packageCheckFn
      ? {
          beforeWrite: async (payload: Record<string, unknown>) => {
            const found = await call.mutate(o.packageCheckFn as string, {
              phone: String(payload.phone ?? ""),
              ...(typeof payload.email === "string" && payload.email !== "" ? { email: payload.email } : {}),
              starts_at: payload.starts_at,
            });
            return found?.ok ? null : texts.noPackage;
          },
        }
      : {}),
  });

  const token = o.reschedule ?? null;
  const reschedule: BookingReschedule | null = token
    ? {
        token,
        title: texts.rescheduleTitle,
        intro: texts.rescheduleIntro,
        submit: texts.moveSubmit,
        chosen: texts.chosen,
        href: (x) => {
          const q = new URLSearchParams({ starts_at: x.start, ends_at: x.end });
          if (s.capacity > 1) q.set("seat", String(x.seat));
          return `${RESCHEDULE_PATH}${encodeURIComponent(token)}?${q.toString()}`;
        },
      }
    : null;
  // The reschedule keeps the booked service and specialist (the runtime put them into the address).
  const fixed = reschedule !== null && chosen !== null && (!o.specialistEntity || who !== null);

  return {
    allowed: reschedule ? true : can("create", entity),
    services: list(services),
    service: chosen,
    selectService: (id) => {
      if (fixed) return;
      setService(id);
      setSlot(null);
    },
    specialists: o.specialistEntity ? list(specialists) : null,
    specialist: who,
    selectSpecialist: (id) => {
      if (fixed) return;
      setSpecialist(id);
      setSlot(null);
    },
    days,
    day,
    selectDay: (d) => {
      setDay(d);
      setSlot(null);
    },
    ready,
    slots,
    slotsLoading: ready && busy.isLoading,
    ...(ready && busy.error ? { slotsError: busy.error } : {}),
    slot,
    selectSlot: (x) => {
      setSlot(x);
      setNotice(null);
    },
    notice,
    form: { ...form, submit: async () => (slot && chosen ? form.submit() : undefined) },
    booked,
    again: () => {
      setBooked(null);
      setSlot(null);
    },
    reschedule,
    fixed,
  };
}

function list(r: { data?: { items: Rec[] }; isLoading: boolean; error?: WzError }): BookingList {
  return { items: r.data?.items ?? [], isLoading: r.isLoading, ...(r.error ? { error: r.error } : {}) };
}
