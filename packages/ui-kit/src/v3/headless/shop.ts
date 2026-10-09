// «Интернет-магазин» without markup (V3-23, builder-v3.md C4): the cart (this browser's localStorage, shared by every
// section of the page and by the tabs), the showcase with «В корзину» and the stock, the checkout (delivery: self-pickup,
// СДЭК pickup point by the module's quote, the shop's courier; contacts with the personal data consent) and the order's
// page with its payment through the ЮKassa connector. Prices, the stock and the delivery price are the server's
// (shopPlaceOrder); the page keeps only what the buyer chose and the secret of his order (made here by
// crypto.getRandomValues) that opens the order's page and its payment. The v3 patterns shop-*, cart-*, checkout-* and
// order-* and the module's v2 pages render these models.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDataSource, useLocation, useNavigate, useRoleSpec } from "../../data/context.js";
import type { Mutation, Rec, WzError } from "../../data/types.js";
import { ru } from "../../i18n/ru.js";
import { type CatalogModel, type UseCatalogOptions, useCatalog, useContent } from "./catalog.js";
import { slugFromPath } from "./content.js";

/** Names of the module contract (@wizard/modules SHOP_NAMES, SHOP_FUNCTIONS, SHOP_PAYMENT, SHOP_ROUTES). */
export const SHOP_DEFAULTS = {
  product: "product",
  category: "product_category",
  point: "pickup_point",
  placeFn: "shopPlaceOrder",
  orderFn: "shopOrder",
  cdekFn: "shopCdekOptions",
  integration: "shop_pay",
  binding: "order",
  cartPath: "/cart",
  orderPath: "/order/",
  productPath: "/shop/",
} as const;

/** Russian texts of the shop (functional wordings, no promises of the owner). */
export const SHOP_TEXTS = {
  emptyCart: "Корзина пуста",
  outOfStock: "Нет в наличии",
  added: "Добавлено в корзину",
  nameRequired: "Укажите имя",
  phoneRequired: "Укажите телефон: 10 цифр после +7",
  emailInvalid: "Проверьте адрес почты",
  pointRequired: "Выберите пункт самовывоза",
  addressRequired: "Укажите адрес доставки: улица, дом, квартира",
  cdekRequired: "Найдите пункты выдачи СДЭК и выберите один",
  cityRequired: "Укажите город",
  busy: "Магазин сейчас занят — попробуйте ещё раз через минуту",
  missing: "Заказ не найден. Откройте его на том устройстве, где оформляли, или напишите в магазин.",
  payFailed: "Не получилось перейти к оплате — попробуйте ещё раз",
  productMissing: "Товар не найден: возможно, его сняли с продажи или адрес набран с ошибкой.",
  consentMessages: "Согласен получать письма о заказе: номер, состав и ссылку на страницу заказа",
} as const;

// ---------------------------------------------------------------- the cart

/** A line of the cart: what the buyer chose; the price is the showcase's (the order takes the server's). */
export interface CartLine {
  id: string;
  name: string;
  price: number | null;
  qty: number;
  photo?: string | null;
  /** Stock when it was added (the quantity buttons stop there); null — the shop keeps no stock. */
  max?: number | null;
}

const CART_KEY = "wz-cart:v1";
const ORDERS_KEY = "wz-shop-orders:v1";
const MAX_LINES = 50;
const MAX_QTY = 99;
const EMPTY: readonly CartLine[] = Object.freeze([]);

let memoryCart: readonly CartLine[] = EMPTY;
let cached: { raw: string | null; lines: readonly CartLine[] } = { raw: null, lines: EMPTY };
const listeners = new Set<() => void>();

const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

function parseCart(raw: string | null): readonly CartLine[] {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return EMPTY;
    const out: CartLine[] = [];
    for (const x of v.slice(0, MAX_LINES)) {
      const l = x as Partial<CartLine>;
      if (typeof l?.id !== "string" || typeof l.name !== "string") continue;
      const qty = Math.min(MAX_QTY, Math.max(1, Math.floor(Number(l.qty) || 1)));
      out.push({
        id: l.id,
        name: l.name.slice(0, 120),
        price: typeof l.price === "number" && Number.isFinite(l.price) ? l.price : null,
        qty,
        photo: typeof l.photo === "string" ? l.photo : null,
        max: typeof l.max === "number" ? l.max : null,
      });
    }
    return out;
  } catch {
    return EMPTY;
  }
}

function readCart(): readonly CartLine[] {
  const s = storage();
  if (!s) return memoryCart;
  let raw: string | null;
  try {
    raw = s.getItem(CART_KEY);
  } catch {
    return memoryCart;
  }
  if (raw !== cached.raw) cached = { raw, lines: parseCart(raw) };
  return cached.lines;
}

function writeCart(lines: readonly CartLine[]): void {
  memoryCart = lines;
  const s = storage();
  try {
    if (lines.length) s?.setItem(CART_KEY, JSON.stringify(lines));
    else s?.removeItem(CART_KEY);
  } catch {
    // Private mode or a full storage: the cart lives in this page only.
  }
  for (const l of listeners) l();
}

function subscribeCart(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === CART_KEY) cb();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** Money in kopecks: sums of the page are added in whole kopecks. */
const kop = (v: number | null | undefined) => Math.round((v ?? 0) * 100);

export interface CartModel {
  lines: readonly CartLine[];
  /** Pieces in the cart. */
  count: number;
  /** Sum of the goods by the showcase's prices, rubles. */
  total: number;
  /** Pieces of a product in the cart. */
  qtyOf(id: string): number;
  add(line: Omit<CartLine, "qty">, qty?: number): void;
  setQty(id: string, qty: number): void;
  remove(id: string): void;
  clear(): void;
}

/** The cart of this browser: the same lines on every section and page of the site. */
export function useCart(): CartModel {
  const lines = useSyncExternalStore(subscribeCart, readCart, () => EMPTY);
  return useMemo(() => {
    const clamp = (l: Pick<CartLine, "max">, qty: number) =>
      Math.max(0, Math.min(MAX_QTY, typeof l.max === "number" ? l.max : MAX_QTY, Math.floor(qty)));
    return {
      lines,
      count: lines.reduce((s, l) => s + l.qty, 0),
      total: lines.reduce((s, l) => s + kop(l.price) * l.qty, 0) / 100,
      qtyOf: (id) => lines.find((l) => l.id === id)?.qty ?? 0,
      add: (line, qty = 1) => {
        const now = readCart();
        const had = now.find((l) => l.id === line.id);
        const next = clamp(line, (had?.qty ?? 0) + qty);
        if (next <= 0) return;
        writeCart(
          had
            ? now.map((l) => (l.id === line.id ? { ...l, ...line, qty: next } : l))
            : [...now, { ...line, qty: next }].slice(-MAX_LINES),
        );
      },
      setQty: (id, qty) => {
        const now = readCart();
        writeCart(
          now.flatMap((l) => {
            if (l.id !== id) return [l];
            const next = clamp(l, qty);
            return next > 0 ? [{ ...l, qty: next }] : [];
          }),
        );
      },
      remove: (id) => writeCart(readCart().filter((l) => l.id !== id)),
      clear: () => writeCart(EMPTY),
    };
  }, [lines]);
}

// ---------------------------------------------------------------- the showcase

export interface ShopFields {
  name?: string;
  price?: string;
  description?: string;
  photo?: string;
  category?: string;
  /** Field of the stock; null — the shop keeps no stock. */
  stock?: string | null;
}

const FIELDS = {
  name: "name",
  price: "price",
  description: "description",
  photo: "photo",
  category: "category",
  stock: "stock",
} as const;

export interface UseShopCatalogOptions extends UseCatalogOptions {
  fields?: ShopFields;
}

export interface ShopItem {
  id: string;
  name: string;
  price: number | null;
  description: string | null;
  photo: string | null;
  /** Pieces in stock; null — no stock kept. */
  stock: number | null;
  /** In stock (or no stock kept) and not all of it already in the cart. */
  canAdd: boolean;
  /** Pieces of it in the cart. */
  inCart: number;
}

export interface ShopCatalogModel extends CatalogModel {
  cart: CartModel;
  /** The item as the showcase shows it. */
  item(row: Rec): ShopItem;
  add(row: Rec): void;
  /** The id of the product just added (a short «Добавлено» note), null otherwise. */
  added: string | null;
}

const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Address of an image field (runtime files.image), the stored path as is. */
export function productPhoto(v: unknown, width: 480 | 960 | 1600 = 960): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.startsWith("/") ? v : `/api/files/${encodeURIComponent(v)}/img/${width}`;
}

/** The products on sale in the owner's order with «В корзину» and the stock. */
export function useShopCatalog(
  entity: string = SHOP_DEFAULTS.product,
  o: UseShopCatalogOptions = {},
): ShopCatalogModel {
  const f = { ...FIELDS, ...o.fields };
  const catalog = useCatalog(entity, {
    ...o,
    categoryField: f.category,
    sort: o.sort ?? { field: "sort_order", dir: "asc" },
  });
  const cart = useCart();
  const [added, setAdded] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const item = (row: Rec): ShopItem => shopItem(row, f, cart);
  return {
    ...catalog,
    cart,
    item,
    add: (row) => {
      const it = item(row);
      if (!it.canAdd) return;
      cart.add({ id: it.id, name: it.name, price: it.price, photo: it.photo, max: it.stock });
      setAdded(it.id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAdded(null), 2500);
    },
    added,
  };
}

/** A product row as the showcase and the product's page show it (fields of the module contract by default). */
function shopItem(row: Rec, fields: ShopFields, cart: CartModel, width: 480 | 960 | 1600 = 960): ShopItem {
  const f = { ...FIELDS, ...fields };
  const stock = f.stock && typeof row[f.stock] === "number" ? (row[f.stock] as number) : null;
  const price = typeof row[f.price] === "number" ? (row[f.price] as number) : null;
  const inCart = cart.qtyOf(row.id);
  return {
    id: row.id,
    name: textOf(row[f.name]) ?? "",
    price,
    description: textOf(row[f.description]),
    photo: productPhoto(row[f.photo], width),
    stock,
    canAdd: (stock === null || stock > inCart) && inCart < MAX_QTY,
    inCart,
  };
}

// ---------------------------------------------------------------- the product's page (V3-18)

/** A record id of the data API (the address of a product's page carries it). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id no row has: the record hook is asked for it while the address names none. */
const NO_ROW = "00000000-0000-0000-0000-000000000000";

export interface UseProductOptions {
  /** Address prefix of the product pages («/shop/»): the product's id is the next segment. */
  path?: string;
  /** A fixed product instead of the address (previews). */
  id?: string;
  fields?: ShopFields;
}

export interface ProductModel {
  /** Id of the address; null — the address names none. */
  id: string | null;
  /** The product as its page shows it (the large photo); null — loading or none. */
  item: ShopItem | null;
  isLoading: boolean;
  /** Loaded and there is no such product on sale for this role (taken off sale, deleted or a wrong address). */
  notFound: boolean;
  error?: WzError;
  cart: CartModel;
  add(qty?: number): void;
  /** Just added: a short «Добавлено в корзину». */
  added: boolean;
  refetch(): void;
}

/** One product of `entity` by the id of the current address (/shop/<id>) with «В корзину» and the stock. */
export function useProduct(entity: string = SHOP_DEFAULTS.product, o: UseProductOptions = {}): ProductModel {
  const ds = useDataSource();
  const { pathname } = useLocation();
  const raw = o.id ?? slugFromPath(pathname, o.path ?? SHOP_DEFAULTS.productPath);
  const id = raw && UUID_RE.test(raw) ? raw : null;
  const rec = ds.useRecord<Rec>(entity, id ?? NO_ROW);
  const cart = useCart();
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const row = id && rec.data ? rec.data : null;
  const item = row ? shopItem(row, o.fields ?? {}, cart, 1600) : null;
  const isLoading = id !== null && rec.isLoading && !row;
  // A row the role may not read (off sale) answers 404: the same «not found» as a wrong address.
  const missing = !isLoading && !row && (!rec.error || rec.error.status === 404 || rec.error.status === 403);
  return {
    id,
    item,
    isLoading,
    notFound: id === null || missing,
    ...(rec.error && !missing ? { error: rec.error } : {}),
    cart,
    add: (qty = 1) => {
      if (!item?.canAdd) return;
      cart.add(
        {
          id: item.id,
          name: item.name,
          price: item.price,
          photo: productPhoto(row?.[FIELDS.photo]),
          max: item.stock,
        },
        qty,
      );
      setAdded(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setAdded(false), 2500);
    },
    added,
    refetch: rec.refetch,
  };
}

// ---------------------------------------------------------------- the checkout

export type DeliveryMethod = "pickup" | "cdek" | "courier";

export interface DeliveryOption {
  value: DeliveryMethod;
  label: string;
}

/** A СДЭК pickup point of the module's quote. */
export interface CdekPoint {
  code: string;
  name: string;
  address: string;
  hours: string;
}

/** The answer of shopCdekOptions: the quote (its price is the order's), the city, the term and the points. */
export interface CdekQuote {
  quote: string;
  city: string;
  price: number;
  days: string;
  points: CdekPoint[];
  /** The passport's mock answered (the shop's СДЭК key is not connected yet): prices are an example. */
  test: boolean;
}

/** What shopPlaceOrder answers. */
export interface PlacedOrder {
  id: string;
  number: number;
  token: string;
  total: number;
  pay: boolean;
}

export interface UseCheckoutOptions {
  /** The delivery methods of the shop, in its order. */
  methods: readonly DeliveryOption[];
  /** The order is paid online right after the checkout (ЮKassa connector). */
  online: boolean;
  /** Price of the shop's courier, rubles. */
  courierPrice?: number;
  /** Entity of the self-pickup points. */
  pointEntity?: string;
  placeFn?: string;
  cdekFn?: string;
  payment?: { integration: string; binding: string };
  /** Prefix of the order's page («/order/»). */
  orderPath?: string;
  /**
   * V3-18: the order keeps the buyer's consent to the letters about it («Напоминания и уведомления»): a separate box,
   * unchecked by default; the letters go only when it is checked (the e-mail is given).
   */
  consentMessages?: boolean;
}

export type CheckoutField = "name" | "phone" | "email" | "address" | "comment";

export interface CheckoutModel {
  cart: CartModel;
  methods: readonly DeliveryOption[];
  method: DeliveryMethod;
  setMethod(m: DeliveryMethod): void;
  /** Self-pickup points (pickup). */
  points: { items: Rec[]; isLoading: boolean };
  pickupPoint: string | null;
  setPickupPoint(id: string | null): void;
  cdek: {
    city: string;
    setCity(city: string): void;
    find(): Promise<void>;
    loading: boolean;
    error: string | null;
    result: CdekQuote | null;
    point: string | null;
    setPoint(code: string | null): void;
  };
  values: Readonly<Record<CheckoutField, string>>;
  setValue(name: CheckoutField, value: string): void;
  errors: Readonly<Partial<Record<CheckoutField | "delivery", string>>>;
  consent: {
    required: boolean;
    checked: boolean;
    set(v: boolean): void;
    error?: string;
    text: string;
    policyPage?: string;
  };
  /** The box of the letters about the order (consentMessages of the shop), null — the shop sends none. */
  messages: { checked: boolean; set(v: boolean): void; text: string } | null;
  /** Price of the chosen delivery, rubles; null — not known yet (СДЭК before the search). */
  deliveryPrice: number | null;
  /** The goods and the delivery by the page's prices (the order's sum is the server's). */
  total: number;
  submit(): Promise<void>;
  pending: boolean;
  formError: string | null;
  /** The placed order (the page goes to its payment or its page). */
  placed: PlacedOrder | null;
}

/** A random secret of 48 characters (crypto.getRandomValues): it opens the order's page and its payment. */
export function orderSecret(): string {
  const bytes = new Uint8Array(24);
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The orders of this browser: id → the buyer's secret. */
function readOrders(): Record<string, string> {
  try {
    const v = JSON.parse(storage()?.getItem(ORDERS_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Keeps the secret of an order in this browser (its page opens it later). */
export function rememberOrder(id: string, token: string): void {
  const all = readOrders();
  all[id] = token;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
  try {
    storage()?.setItem(ORDERS_KEY, JSON.stringify(all));
  } catch {
    // Without a storage the order's page opens by the link with ?t= only.
  }
}

/** The secret of an order: ?t= of the address, else this browser's. */
export function orderToken(id: string, search: string): string | null {
  const t = new URLSearchParams(search).get("t");
  if (t && /^[A-Za-z0-9_-]{32,64}$/.test(t)) return t;
  return readOrders()[id] ?? null;
}

const PAYING_KEY = (id: string) => `wz-shop-paying:${id}`;

/** A whole-page navigation (the payment page of ЮKassa or the draft's mock page). */
function goTo(url: string): void {
  if (typeof window !== "undefined") window.location.assign(url);
}

const useNoPay = (): Mutation<[string, string, string, string?], string> => ({
  mutate: async () => {
    throw { code: "NOT_FOUND", message: SHOP_TEXTS.payFailed, status: 404 } satisfies WzError;
  },
  pending: false,
  reset: () => {},
});

const digits = (s: string) => s.replace(/\D/g, "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The checkout of the cart: delivery, contacts with consent, the order and (online) its payment. */
export function useCheckout(o: UseCheckoutOptions): CheckoutModel {
  const spec = useRoleSpec();
  const ds = useDataSource();
  const navigate = useNavigate();
  const cart = useCart();
  const place = ds.useCall<PlacedOrder>();
  const cdekCall = ds.useCall<CdekQuote>();
  const pay = (ds.usePay ?? useNoPay)();
  const methods = o.methods.length ? o.methods : [{ value: "pickup", label: "Самовывоз" } as const];
  const [method, setMethodState] = useState<DeliveryMethod>(methods[0]?.value ?? "pickup");
  const pointEntity = o.pointEntity ?? SHOP_DEFAULTS.point;
  const hasPickup = methods.some((m) => m.value === "pickup");
  const pointList = useContent(pointEntity, {
    filter: { active: true },
    sort: { field: "sort_order", dir: "asc" },
    pageSize: 24,
  });
  const [pickupPoint, setPickupPoint] = useState<string | null>(null);
  const [city, setCity] = useState("");
  const [quote, setQuote] = useState<CdekQuote | null>(null);
  const [cdekError, setCdekError] = useState<string | null>(null);
  const [cdekPoint, setCdekPoint] = useState<string | null>(null);
  const [values, setValues] = useState<Record<CheckoutField, string>>({
    name: "",
    phone: "",
    email: "",
    address: "",
    comment: "",
  });
  const [errors, setErrors] = useState<Partial<Record<CheckoutField | "delivery", string>>>({});
  const [consent, setConsent] = useState(false);
  const [messages, setMessages] = useState(false);
  const [consentError, setConsentError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const busy = useRef(false);
  const isAdmin = !!spec.roles.find((r) => r.name === spec.role)?.isAdmin;
  // Points load on their own: only the first one is chosen for the buyer when the shop has one.
  const firstPoint = pointList.items.length === 1 ? (pointList.items[0]?.id ?? null) : null;
  useEffect(() => {
    if (pickupPoint === null && firstPoint) setPickupPoint(firstPoint);
  }, [firstPoint, pickupPoint]);

  const deliveryPrice =
    method === "pickup"
      ? 0
      : method === "courier"
        ? (o.courierPrice ?? null)
        : quote && cdekPoint
          ? quote.price
          : (quote?.price ?? null);
  const total = (kop(cart.total) + kop(deliveryPrice)) / 100;
  const orderPath = o.orderPath ?? SHOP_DEFAULTS.orderPath;
  const cartLines = () => cart.lines.map((l) => ({ product: l.id, qty: l.qty }));

  const find = async () => {
    const c = city.trim();
    setCdekError(null);
    if (c.length < 2) {
      setCdekError(SHOP_TEXTS.cityRequired);
      return;
    }
    try {
      const r = await cdekCall.mutate(o.cdekFn ?? SHOP_DEFAULTS.cdekFn, { city: c, lines: cartLines() });
      setQuote(r);
      setCdekPoint(r.points.length === 1 ? (r.points[0]?.code ?? null) : null);
    } catch (e) {
      setQuote(null);
      setCdekPoint(null);
      setCdekError((e as WzError).message || SHOP_TEXTS.busy);
    }
  };

  const validate = () => {
    const out: Partial<Record<CheckoutField | "delivery", string>> = {};
    if (!values.name.trim()) out.name = SHOP_TEXTS.nameRequired;
    if (digits(values.phone).length < 10) out.phone = SHOP_TEXTS.phoneRequired;
    if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) out.email = SHOP_TEXTS.emailInvalid;
    if (method === "pickup" && !pickupPoint) out.delivery = SHOP_TEXTS.pointRequired;
    if (method === "courier" && values.address.trim().length < 5) out.address = SHOP_TEXTS.addressRequired;
    if (method === "cdek" && (!quote || !cdekPoint)) out.delivery = SHOP_TEXTS.cdekRequired;
    return out;
  };

  const submit = async () => {
    if (busy.current || place.pending) return;
    setFormError(null);
    if (cart.lines.length === 0) {
      setFormError(SHOP_TEXTS.emptyCart);
      return;
    }
    const errs = validate();
    setErrors(errs);
    const consentMissing = !isAdmin && !consent;
    setConsentError(consentMissing ? ru.consent.error : undefined);
    if (Object.keys(errs).length || consentMissing) return;
    const token = orderSecret();
    const phone = digits(values.phone);
    const args: Record<string, unknown> = {
      lines: cartLines(),
      delivery: method,
      name: values.name.trim(),
      phone: `+${phone.length === 10 ? `7${phone}` : phone.replace(/^8/, "7")}`,
      token,
      ...(values.email.trim() ? { email: values.email.trim() } : {}),
      ...(values.comment.trim() ? { comment: values.comment.trim() } : {}),
      ...(method === "pickup" && pickupPoint ? { pickupPoint } : {}),
      ...(method === "courier" ? { address: values.address.trim() } : {}),
      ...(method === "cdek" && quote && cdekPoint ? { quote: quote.quote, cdekPoint } : {}),
      ...(o.consentMessages && values.email.trim() ? { consentMessages: messages } : {}),
    };
    busy.current = true;
    try {
      let order: PlacedOrder | null = null;
      // Concurrent orders of the same goods make the server retry; after its retries the page tries twice more.
      for (let attempt = 0; attempt < 3 && !order; attempt++) {
        try {
          order = await place.mutate(
            o.placeFn ?? SHOP_DEFAULTS.placeFn,
            args,
            isAdmin ? undefined : { consent: true },
          );
        } catch (e) {
          if ((e as WzError).code !== "CONFLICT" || attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 250)));
        }
      }
      if (!order) return;
      rememberOrder(order.id, order.token);
      cart.clear();
      setPlaced(order);
      if (order.pay && o.online && o.payment) {
        try {
          const url = await pay.mutate(o.payment.integration, o.payment.binding, order.id, order.token);
          try {
            sessionStorage.setItem(PAYING_KEY(order.id), "1");
          } catch {
            // Without the flag the order's page does not wait for the payment's notice.
          }
          goTo(url);
          return;
        } catch {
          // The order exists: its page offers the payment again.
        }
      }
      navigate(`${orderPath}${encodeURIComponent(order.id)}`);
    } catch (e) {
      const w = e as WzError;
      const byField: Partial<Record<CheckoutField | "delivery", string>> = {};
      for (const fe of w.fields ?? [])
        if (["name", "phone", "email", "address", "comment"].includes(fe.field))
          byField[fe.field as CheckoutField] = fe.message;
      setErrors(byField);
      if (w.code === "CONSENT_REQUIRED") setConsentError(w.message);
      else if (w.code === "QUOTE_EXPIRED") {
        setQuote(null);
        setCdekPoint(null);
        setFormError(w.message);
      } else if (w.code === "CONFLICT") setFormError(SHOP_TEXTS.busy);
      else if (!Object.keys(byField).length) setFormError(w.message || SHOP_TEXTS.busy);
    } finally {
      busy.current = false;
    }
  };

  return {
    cart,
    methods,
    method,
    setMethod: (m) => {
      setMethodState(m);
      setErrors((e) => ({ ...e, delivery: undefined }));
    },
    points: { items: hasPickup ? pointList.items : [], isLoading: hasPickup && pointList.isLoading },
    pickupPoint,
    setPickupPoint,
    cdek: {
      city,
      setCity,
      find,
      loading: cdekCall.pending,
      error: cdekError,
      result: quote,
      point: cdekPoint,
      setPoint: setCdekPoint,
    },
    values,
    setValue: (name, value) => setValues((v) => ({ ...v, [name]: value })),
    errors,
    consent: {
      required: !isAdmin,
      checked: consent,
      set: (c) => {
        setConsent(c);
        if (c) setConsentError(undefined);
      },
      ...(consentError !== undefined ? { error: consentError } : {}),
      text: spec.compliance?.consentText ?? ru.consent.defaultText,
      ...(spec.compliance?.policyPage ? { policyPage: spec.compliance.policyPage } : {}),
    },
    messages: o.consentMessages
      ? { checked: messages, set: setMessages, text: SHOP_TEXTS.consentMessages }
      : null,
    deliveryPrice,
    total,
    submit,
    pending: place.pending || pay.pending,
    formError,
    placed,
  };
}

// ---------------------------------------------------------------- the order's page

/** The order as shopOrder gives it to its buyer (no contacts). */
export interface OrderView {
  id: string;
  number: number;
  status: string;
  statusLabel: string;
  paid: boolean;
  payable: boolean;
  payUntil: string | null;
  total: number;
  itemsTotal: number;
  deliveryPrice: number;
  delivery: string;
  deliveryLabel: string;
  pickup: { name: string; address: string; hours: string | null } | null;
  cdek: { city: string | null; address: string; days: string | null; track: string | null } | null;
  courier: boolean;
  lines: { name: string; qty: number; price: number; sum: number }[];
  createdAt: string | null;
}

export interface UseOrderOptions {
  /** Prefix of the order's page («/order/»). */
  path?: string;
  orderFn?: string;
  payment?: { integration: string; binding: string } | null;
}

export interface OrderModel {
  state: "loading" | "missing" | "ready";
  order: OrderView | null;
  /** Online payment of an order that waits for it. */
  canPay: boolean;
  pay(): Promise<void>;
  paying: boolean;
  payError: string | null;
  /** Back from the payment page, the notice of ЮKassa is not in yet: the page asks again. */
  checking: boolean;
}

/** The order of the address (/order/<id>) by the buyer's secret; its payment again while it waits for one. */
export function useOrder(o: UseOrderOptions = {}): OrderModel {
  const ds = useDataSource();
  const { pathname, search } = useLocation();
  const id = slugFromPath(pathname, o.path ?? SHOP_DEFAULTS.orderPath);
  const token = id ? orderToken(id, search) : null;
  const res = ds.useFn<OrderView | null>(
    o.orderFn ?? SHOP_DEFAULTS.orderFn,
    id && token ? { id, token } : "skip",
  );
  const pay = (ds.usePay ?? useNoPay)();
  const payCheck = (ds.usePayCheck ?? useNoPay)();
  const [payError, setPayError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const order = res.data ?? null;
  let returning = false;
  try {
    returning =
      !!id && typeof sessionStorage !== "undefined" && sessionStorage.getItem(PAYING_KEY(id)) === "1";
  } catch {
    returning = false;
  }
  const checking = returning && !!order?.payable && tries < 20;
  const refetch = res.refetch;
  const check = payCheck.mutate;
  const payment = o.payment;
  useEffect(() => {
    if (!checking) return;
    const t = setTimeout(
      () => {
        setTries((n) => n + 1);
        // The notice of ЮKassa may be late or never come: the runtime re-reads the payment (yookassa.yaml#return_check).
        const asked =
          payment && id && token
            ? check(payment.integration, payment.binding, id, token).catch(() => "")
            : Promise.resolve("");
        void asked.then(() => refetch());
      },
      tries === 0 ? 300 : 3000,
    );
    return () => clearTimeout(t);
  }, [checking, refetch, check, payment, id, token, tries]);
  useEffect(() => {
    if (id && order && !order.payable) {
      try {
        sessionStorage.removeItem(PAYING_KEY(id));
      } catch {
        // nothing to clear
      }
    }
  }, [id, order]);
  const doPay = useCallback(async () => {
    if (!id || !token || !o.payment) return;
    setPayError(null);
    try {
      const url = await pay.mutate(o.payment.integration, o.payment.binding, id, token);
      try {
        sessionStorage.setItem(PAYING_KEY(id), "1");
      } catch {
        // see useCheckout
      }
      goTo(url);
    } catch (e) {
      setPayError((e as WzError).message || SHOP_TEXTS.payFailed);
    }
  }, [id, token, o.payment, pay]);
  const state =
    !id || !token ? "missing" : res.isLoading && !res.data ? "loading" : order ? "ready" : "missing";
  return {
    state,
    order,
    canPay: !!order?.payable && !!o.payment,
    pay: doPay,
    paying: pay.pending,
    payError,
    checking,
  };
}

/** «1 500 ₽» of a sum in rubles. */
export const rub = (v: number | null | undefined): string =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(v ?? 0);
