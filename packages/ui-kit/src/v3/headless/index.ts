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
/**
 * V3-24 «Контент и блог»: useEntry(entity, {path}) — an entry by the slug of the address; useRubric(o) — the posts of a
 * rubric with the rubric list; richText(body) → blocks of a markdown subset (rendered by code, never as HTML);
 * safeHref, slugFromPath, useEntryTitle.
 */
export {
  type EntryModel,
  RICH_TEXT_MAX,
  type RichBlock,
  type RichInline,
  type RubricModel,
  richInline,
  richPlain,
  richText,
  safeHref,
  slugFromPath,
  type UseEntryOptions,
  type UseRubricOptions,
  useEntry,
  useEntryTitle,
  useRubric,
} from "./content.js";
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
/**
 * V3-23 «Интернет-магазин»: useCart() — the cart of this browser; useShopCatalog(entity, o) — goods with «В корзину» and
 * the stock; useCheckout(o) — delivery (self-pickup, СДЭК by the module's quote, courier), contacts with consent, the
 * order and its payment (ЮKassa); useOrder(o) — the order's page by the buyer's secret; rub(sum).
 */
export {
  type CartLine,
  type CartModel,
  type CdekPoint,
  type CdekQuote,
  type CheckoutField,
  type CheckoutModel,
  type DeliveryMethod,
  type DeliveryOption,
  type OrderModel,
  type OrderView,
  orderSecret,
  orderToken,
  type PlacedOrder,
  productPhoto,
  rememberOrder,
  rub,
  SHOP_DEFAULTS,
  SHOP_TEXTS,
  type ShopCatalogModel,
  type ShopFields,
  type ShopItem,
  type UseCheckoutOptions,
  type UseOrderOptions,
  type UseShopCatalogOptions,
  useCart,
  useCheckout,
  useOrder,
  useShopCatalog,
} from "./shop.js";
