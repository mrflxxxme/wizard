// Demo fixtures for the «форум» and «кондитерская» specs, generated deterministically (no hand-written rows).
import type { AppSpec } from "@wizard/appspec";
import bakeryJson from "../../../specs/appspec/examples/bakery.json" with { type: "json" };
import forumJson from "../../../specs/appspec/examples/forum.json" with { type: "json" };
import type { StatsData } from "../src/index.js";
import { type MemoryOptions, type MemoryUser, memoryQrToken } from "../src/testing/index.js";

/** Demo-only tweak: participants may also log in by phone (shows phone_otp with the memory dev-sender). */
export const forum: AppSpec = {
  ...(forumJson as unknown as AppSpec),
  roles: (forumJson as unknown as AppSpec).roles.map((r) =>
    r.name === "participant" ? { ...r, loginMethods: [...(r.loginMethods ?? []), "phone_otp"] } : r,
  ),
};
export const bakery = bakeryJson as unknown as AppSpec;
export type SpecKey = "forum" | "bakery";
export const SPECS: Record<SpecKey, AppSpec> = { forum, bakery };

type Row = Record<string, unknown> & { id: string };
export type Fixture = {
  rows: Record<string, Row[]>;
  users: MemoryUser[];
  functions: MemoryOptions["functions"];
};

const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);
const day = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const pad = (n: number, w = 3) => String(n).padStart(w, "0");

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function users(spec: AppSpec, extra: Record<string, Partial<MemoryUser>> = {}): MemoryUser[] {
  const names: Record<string, string> = {
    organizer: "Ольга Кравец",
    moderator: "Марат Хасанов",
    speaker: "Светлана Ли",
    partner: "Павел Орлов",
    participant: "Иван Петров",
    volunteer: "Вера Смирнова",
    owner: "Анна Сахарова",
    staff: "Дина Кондитер",
    customer: "Кирилл Морозов",
  };
  return spec.roles
    .filter((r) => r.access === "login")
    .map((r) => ({
      id: `u_${r.name}`,
      role: r.name,
      displayName: names[r.name] ?? r.label,
      isAdmin: !!r.isAdmin,
      email: `${r.name}@demo.example`,
      ...extra[r.name],
    }));
}

const FIRST = ["Анна", "Борис", "Виктор", "Галина", "Дмитрий", "Елена", "Жанна", "Зоя", "Игорь", "Ксения"];
const LAST = ["Иванова", "Смирнов", "Кузнецова", "Попов", "Васильева", "Соколов", "Михайлова", "Новиков"];
const TOPICS = [
  "Омниканальность",
  "Склад без бумаги",
  "Цены и маржа",
  "Лояльность",
  "Маркетплейсы",
  "Аналитика полки",
];

export function forumFixture(): Fixture {
  const r = rng(42);
  const stream = ["Ритейл-технологии", "Логистика", "Маркетинг"].map((name, i) => ({
    id: `stream_${i + 1}`,
    name,
    capacity: 200,
    description: `Поток «${name}»`,
  }));
  const ticket_type = [
    { id: "tt_standard", name: "Стандарт", kind: "standard", price: 9900, capacity: 400, active: true },
    { id: "tt_vip", name: "VIP", kind: "vip", price: 24900, capacity: 3, active: true },
    { id: "tt_partner", name: "Партнёрский", kind: "partner", price: 0, capacity: 150, active: true },
  ].map((t) => ({ ...t, description: `Билет «${t.name}»: доступ ко всем потокам` }));
  const ticket: Row[] = [];
  const addTicket = (holder: string, type: string, status: string, i: number) =>
    ticket.push({
      id: `ticket_${pad(i)}`,
      ticket_type: type,
      stream: stream[i % 3]?.id,
      holder_user: holder,
      holder_name: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
      holder_email: `guest${i}@demo.example`,
      holder_phone: `+7900${pad(i, 7)}`,
      company: "ООО «Ромашка»",
      status,
      amount: type === "tt_vip" ? 24900 : 9900,
      qr_token: memoryQrToken(`ticket_${pad(i)}.${Math.floor(r() * 1e9).toString(36)}`),
      event_starts_at: iso(Date.UTC(2026, 10, 14, 6, 30)),
      created_at: iso(BASE - i * day),
    });
  addTicket("u_participant", "tt_standard", "paid", 1);
  for (let i = 2; i <= 4; i++) addTicket("u_other", "tt_vip", "paid", i);
  for (let i = 5; i <= 22; i++) addTicket("u_other", "tt_standard", i % 4 ? "paid" : "issued", i);
  const statuses = ["new", "approved", "rejected"];
  const speaker_application = Array.from({ length: 60 }, (_, k) => {
    const i = k + 1;
    return {
      id: `app_${pad(i)}`,
      speaker_user: i === 3 ? "u_speaker" : `u_spk_${i}`,
      full_name: `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`,
      email: `speaker${i}@demo.example`,
      phone: `+7911${pad(i, 7)}`,
      company: `Компания ${i}`,
      topic: `${TOPICS[i % TOPICS.length]}: опыт №${i}`,
      abstract: "Кейс внедрения, цифры до и после, ошибки и выводы.",
      stream: stream[i % 3]?.id,
      status: statuses[i % 3],
      created_at: iso(BASE - Math.floor(r() * 90) * day - i * 60_000),
    };
  });
  const rows = { stream, ticket_type, ticket, speaker_application } as Record<string, Row[]>;
  return {
    rows,
    users: users(forum, { participant: { phone: "+79001234510" } }),
    functions: {
      ticketAvailability: (_a, { ds }) =>
        ds.rows("ticket_type").map((t) => ({
          id: t.id,
          left:
            Number(t.capacity) -
            ds.rows("ticket").filter((x) => x.ticket_type === t.id && x.status !== "canceled").length,
        })),
      forumStats: (): StatsData => ({
        kpis: [
          { id: "registered", label: "Зарегистрировано", value: 370, total: 600, format: "int" },
          { id: "revenue", label: "Выручка", value: 4_100_000, format: "money" },
          { id: "paid", label: "Оплачено", value: 0.82, format: "percent" },
          { id: "speakers", label: "Заявок спикеров", value: 60, format: "int", hint: "20 новых" },
        ],
        bars: {
          title: "Загрузка потоков",
          items: [
            { label: "Ритейл-технологии", value: 156, max: 200 },
            { label: "Логистика", value: 120, max: 200 },
            { label: "Маркетинг", value: 94, max: 200 },
          ],
        },
      }),
    },
  };
}

export function bakeryFixture(): Fixture {
  const product = ["Медовик", "Красный бархат", "Наполеон"].map((name, i) => ({
    id: `product_${i + 1}`,
    name,
    description: `Торт «${name}» ручной работы`,
    active: true,
  }));
  const product_option = [
    ["weight", "1,5 кг", 0],
    ["weight", "2 кг", 900],
    ["filling", "Вишня", 0],
    ["filling", "Солёная карамель", 600],
    ["decor", "Ягоды", 500],
  ].map(([g, title, price], i) => ({
    id: `opt_${i + 1}`,
    product: "product_1",
    option_group: g,
    title,
    price,
    sort_order: i,
    active: true,
  }));
  const production_slot = Array.from({ length: 5 }, (_, i) => ({
    id: `slot_${i + 1}`,
    slot_date: iso(BASE + (i + 2) * day).slice(0, 10),
    capacity: 6,
    closed: false,
  }));
  const statuses = [
    "prepaid",
    "prepaid",
    "prepaid",
    "in_production",
    "in_production",
    "ready",
    "pending_payment",
    "completed",
  ];
  const cake_order = statuses.map((status, i) => ({
    id: `order_${pad(i + 1)}`,
    number: 101 + i,
    customer_user: i === 0 ? "u_customer" : "u_other",
    product: product[i % 3]?.id,
    options: { weight: "opt_1", filling: "opt_3" },
    inscription: i % 2 ? "С днём рождения!" : "",
    slot: production_slot[i % 5]?.id,
    fulfillment: i % 2 ? "delivery" : "pickup",
    customer_name: `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`,
    customer_phone: `+7917${pad(i + 1, 7)}`,
    customer_email: `client${i + 1}@demo.example`,
    address: i % 2 ? "г. Казань, ул. Пушкина, 1" : "",
    total: 4900 + i * 300,
    prepay_amount: 2450 + i * 150,
    remaining_amount: 2450 + i * 150,
    status,
    created_at: iso(BASE - i * 3_600_000),
  }));
  return {
    rows: { product, product_option, production_slot, cake_order } as Record<string, Row[]>,
    users: users(bakery),
    functions: {
      calcPrice: (a) => {
        const { options = [] } = (a ?? {}) as { options?: string[] };
        return (
          4900 + options.reduce((s, id) => s + Number(product_option.find((o) => o.id === id)?.price ?? 0), 0)
        );
      },
    },
  };
}

export const FIXTURES: Record<SpecKey, () => Fixture> = { forum: forumFixture, bakery: bakeryFixture };
