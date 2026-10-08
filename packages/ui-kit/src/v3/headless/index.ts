// @wizard/ui-kit/v3/headless (V3-10, specs/agents/builder-v3.md §3 C4): headless hooks of the module actions for the
// patterns of v3 — data, permissions, the personal data consent and states over @wizard/sdk (the DataSource of the
// WzProvider the system template mounts), no markup. The public actions of a backend-mode system name their hook
// (@wizard/modules publicFront.actions[].hook).

/** useBooking(o) — service → specialist → day → free slots (busySlots + the module's schedule) → contacts with consent → booking. */
export {
  BOOKING_TEXTS,
  type BookingList,
  type BookingModel,
  type UseBookingOptions,
  useBooking,
} from "./booking.js";
/** useCatalog(entity?, o) — visible catalog items in the owner's order with sections; useContent(entity, o) — any public list. */
export {
  CATALOG_DEFAULTS,
  type CatalogModel,
  type UseCatalogOptions,
  type UseContentOptions,
  useCatalog,
  useContent,
} from "./catalog.js";
/** useFormModel(o) — fields, validation, server errors, consent (G2-PII-04) and create/update; RecordForm renders it. */
export {
  type ConsentModel,
  defaultFormFields,
  type FormModel,
  type FormModelOptions,
  NEVER_EDITED,
  useFormModel,
} from "./form.js";
/** useLeadForm(entity, o) — the lead form: allowed, fields with consent, «sent» and again(). */
export { type LeadFormModel, type UseLeadFormOptions, useLeadForm } from "./lead-form.js";
/** usePagedList(entity, query, {page, max}) — «Показать ещё» by a page, ≤ 96 rows, read permission. */
export { LIST_MAX, LIST_PAGE, type PagedList, usePagedList } from "./list.js";
/** Schedule of «Запись по слотам»: workdays, daySlots, freeSlots (the first free seat), zonedAt, dayKey, addDays. */
export {
  addDays,
  type BusyTime,
  dayKey,
  daySlots,
  type FreeSlot,
  freeSlots,
  type ScheduleSpec,
  workdays,
  zonedAt,
} from "./schedule.js";
