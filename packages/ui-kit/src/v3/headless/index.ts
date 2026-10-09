// @wizard/ui-kit/v3/headless (V3-10, specs/agents/builder-v3.md §3 C4): headless hooks of the module actions for the
// patterns of v3 — data, permissions, the personal data consent and states over @wizard/sdk (the DataSource of the
// WzProvider the system template mounts), no markup. The public actions of a backend-mode system name their hook
// (@wizard/modules publicFront.actions[].hook).

/**
 * Client cabinet (V3-18): useMyRecords(entity, o) — the visitor's own rows (rowFilter on the server) as texts, «Отменить»
 * when allowed; useClientSession() — signed in or not, the name, sign out; cellText(field, value).
 */
export {
  type ClientSession,
  cellText,
  MY_RECORDS_FIELDS,
  type MyRecord,
  type MyRecordCell,
  type MyRecordsModel,
  type UseMyRecordsOptions,
  useClientSession,
  useMyRecords,
} from "./account.js";
/**
 * useBooking(o) — service → specialist → day → free slots (busySlots + the module's schedule) → contacts with consent →
 * booking; with o.reschedule (?reschedule= of the e-mail, bookingAddress()) the chosen time goes to the runtime's
 * confirmation (reschedule.href) with the service fixed (V3-18).
 */
export {
  BOOKING_TEXTS,
  type BookingAddress,
  type BookingList,
  type BookingModel,
  type BookingReschedule,
  bookingAddress,
  RESCHEDULE_PATH,
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
/** useFitWords(text) — ref of a display heading whose words never break inside (the size goes down to fit, V3-18). */
export { useFitWords } from "./fit.js";
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
/** useSitePhotos() — the owner's photos of the site's places («Фото сайта», site_photo), else the stock ones (V3-18). */
export {
  SITE_PHOTO_DEFAULTS,
  type SitePhoto,
  type SitePhotos,
  type UseSitePhotosOptions,
  useSitePhotos,
} from "./photos.js";
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
 * order and its payment (ЮKassa); useOrder(o) — the order's page by the buyer's secret; useProduct(entity, o) — a
 * product's page by the id of the address (V3-18); rub(sum).
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
  type ProductModel,
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
  type UseProductOptions,
  type UseShopCatalogOptions,
  useCart,
  useCheckout,
  useOrder,
  useProduct,
  useShopCatalog,
} from "./shop.js";
