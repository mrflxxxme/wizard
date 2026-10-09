// Data of the v3 preview system for the module-bound patterns (V3-08: form, catalog, blog): the entities a backend-mode
// system gives the public front (@wizard/modules compilePlan front "backend": «Заявки» lead, «Запись по слотам» booking
// with specialists, «Каталог и прайс» service with sections, and a post list added by an extension op), example rows,
// and a stand-in for the runtime endpoints the SDK DataSource of the system template calls (/api/data, /api/fn,
// /api/events, /api/files). Example content of the preview only (D49): never published as a client's text.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppSpec, Entity, Permission } from "@wizard/appspec";
import { type ScheduleSpec, zonedAt } from "@wizard/ui-kit/v3/headless";

/** Public role of the preview system (the forum fixture's). */
export const PREVIEW_ROLE = "visitor";

/** Working hours of the booking examples: Mon–Sat 10:00–20:00 Moscow time, break 14:00–15:00, one visitor per time. */
export const PREVIEW_SCHEDULE: ScheduleSpec = {
  tz: "Europe/Moscow",
  days: [1, 2, 3, 4, 5, 6],
  start: 600,
  end: 1200,
  step: 60,
  breakStart: 840,
  breakEnd: 900,
  capacity: 1,
  leadMinutes: 60,
};

const STATUS = [
  { value: "new", label: "Новая" },
  { value: "done", label: "Закрыта" },
];

/** Entities in the shape the module recipes compile them (names of the catalog and booking contracts). */
export const PREVIEW_ENTITIES: Entity[] = [
  {
    name: "lead",
    label: "Заявка",
    fields: [
      {
        name: "name",
        label: "Имя",
        type: "string",
        required: true,
        maxLength: 120,
        pii: "basic",
        piiKind: "fio",
      },
      { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic", piiKind: "phone" },
      { name: "email", label: "Почта", type: "email", pii: "basic", piiKind: "email" },
      {
        name: "comment",
        label: "Комментарий",
        type: "text",
        maxLength: 2000,
        pii: "basic",
        piiKind: "free_text",
      },
      { name: "preferred_time", label: "Удобное время для звонка", type: "string", maxLength: 120 },
      {
        name: "service",
        label: "Что интересует",
        type: "ref",
        ref: { entity: "service", onDelete: "set_null" },
      },
      { name: "status", label: "Статус", type: "enum", required: true, default: "new", enum: STATUS },
    ],
    retention: { deleteAfterDays: 365 },
  },
  {
    name: "service_category",
    label: "Раздел каталога",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 80 },
      { name: "sort_order", label: "Порядок на витрине", type: "int" },
    ],
  },
  {
    name: "service",
    label: "Услуга",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
      { name: "price", label: "Цена, ₽", type: "money", min: 0 },
      { name: "duration_min", label: "Длительность, мин", type: "int", min: 5, max: 1440 },
      { name: "category", label: "Раздел", type: "ref", ref: { entity: "service_category" } },
      { name: "active", label: "На витрине", type: "bool", required: true, default: true },
      { name: "description", label: "Описание", type: "text", maxLength: 1000 },
      { name: "photo", label: "Фото", type: "image" },
      { name: "sort_order", label: "Порядок на витрине", type: "int" },
    ],
  },
  {
    name: "specialist",
    label: "Мастер",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
      { name: "active", label: "Принимает записи", type: "bool", default: true },
    ],
  },
  {
    name: "booking",
    label: "Запись",
    fields: [
      { name: "starts_at", label: "Начало", type: "datetime", required: true },
      { name: "service", label: "Услуга", type: "ref", required: true, ref: { entity: "service" } },
      { name: "specialist", label: "Мастер", type: "ref", ref: { entity: "specialist" } },
      { name: "status", label: "Статус", type: "enum", required: true, default: "new", enum: STATUS },
      {
        name: "name",
        label: "Имя",
        type: "string",
        required: true,
        maxLength: 120,
        pii: "basic",
        piiKind: "fio",
      },
      { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic", piiKind: "phone" },
      {
        name: "consent_messages",
        label: "Согласен получать напоминания о записи",
        type: "bool",
        default: false,
      },
      { name: "ends_at", label: "Окончание", type: "datetime", required: true },
      { name: "seat", label: "Место", type: "int", default: 1, min: 1, max: 1 },
    ],
    retention: { deleteAfterDays: 365 },
  },
  {
    name: "post",
    label: "Запись блога",
    fields: [
      { name: "title", label: "Заголовок", type: "string", required: true, maxLength: 140 },
      { name: "published_at", label: "Дата", type: "date", required: true },
      { name: "excerpt", label: "Анонс", type: "text", maxLength: 400 },
      { name: "cover", label: "Обложка", type: "image" },
      { name: "slug", label: "Адрес", type: "string", maxLength: 80 },
    ],
  },
  // V3-24 «Контент и блог»: rubrics and articles of the module (CONTENT_NAMES of @wizard/modules).
  {
    name: "rubric",
    label: "Рубрика",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 80 },
      { name: "slug", label: "Адрес", type: "string", required: true, maxLength: 80 },
      { name: "description", label: "Описание", type: "text", maxLength: 300 },
      { name: "sort_order", label: "Порядок", type: "int" },
    ],
  },
  {
    name: "article",
    label: "Статья",
    fields: [
      { name: "title", label: "Заголовок", type: "string", required: true, maxLength: 140 },
      { name: "status", label: "Статус", type: "string", maxLength: 20 },
      { name: "published_at", label: "Дата публикации", type: "date", required: true },
      { name: "rubric", label: "Рубрика", type: "ref", ref: { entity: "rubric", onDelete: "set_null" } },
      { name: "slug", label: "Адрес", type: "string", required: true, maxLength: 80 },
      { name: "excerpt", label: "Анонс", type: "text", maxLength: 300 },
      { name: "body", label: "Текст", type: "text", maxLength: 20000 },
      { name: "cover", label: "Обложка", type: "image" },
      { name: "seo_title", label: "Заголовок для поисковиков", type: "string", maxLength: 70 },
      { name: "seo_description", label: "Описание для поисковиков", type: "string", maxLength: 160 },
    ],
  },
];

/** What the public role may do: create leads and bookings, read the catalog, the masters and the posts. */
export const PREVIEW_PERMISSIONS: Permission[] = [
  { role: PREVIEW_ROLE, entity: "lead", ops: ["create"], readonlyFields: ["status"] },
  { role: PREVIEW_ROLE, entity: "booking", ops: ["create"], readonlyFields: ["status", "seat"] },
  { role: PREVIEW_ROLE, entity: "service", ops: ["read"], rowFilter: { active: true } },
  { role: PREVIEW_ROLE, entity: "service_category", ops: ["read"] },
  { role: PREVIEW_ROLE, entity: "specialist", ops: ["read"], rowFilter: { active: true } },
  { role: PREVIEW_ROLE, entity: "post", ops: ["read"] },
  { role: PREVIEW_ROLE, entity: "rubric", ops: ["read"] },
  { role: PREVIEW_ROLE, entity: "article", ops: ["read"], rowFilter: { status: "published" } },
];

/** The forum fixture plus the preview entities, their public permissions and a neutral consent text. */
export function withPreviewData(spec: AppSpec): AppSpec {
  return {
    ...spec,
    entities: [...spec.entities, ...PREVIEW_ENTITIES],
    permissions: [...spec.permissions, ...PREVIEW_PERMISSIONS],
    compliance: {
      ...spec.compliance,
      consentText: "Я соглашаюсь на обработку моих персональных данных для ответа на обращение",
      policyPage: "/privacy",
    },
  };
}

type Row = Record<string, unknown> & { id: string };

const service = (
  i: number,
  name: string,
  price: number | null,
  duration: number | null,
  category: string,
  description: string,
  photo = true,
): Row => ({
  id: `s${String(i).padStart(2, "0")}`,
  name,
  price,
  duration_min: duration,
  category,
  active: true,
  description,
  photo: photo ? `f_service_${i}` : null,
  sort_order: i,
});

const post = (i: number, title: string, date: string, excerpt: string, cover = true): Row => ({
  id: `p${String(i).padStart(2, "0")}`,
  title,
  published_at: date,
  excerpt,
  cover: cover ? `f_post_${i}` : null,
  slug: `zapis-${i}`,
});

/** A published article of «Контент и блог» (V3-24): its rubric and its body in the markdown subset. */
const article = (
  i: number,
  title: string,
  slug: string,
  date: string,
  rubric: string,
  excerpt: string,
  body: string,
  cover = true,
): Row => ({
  id: `a${String(i).padStart(2, "0")}`,
  title,
  status: "published",
  published_at: date,
  rubric,
  slug,
  excerpt,
  body,
  cover: cover ? `f_article_${i}` : null,
  seo_title: null,
  seo_description: null,
});

/** Example rows of a pottery studio (the business of the other pattern examples). */
export const PREVIEW_ROWS: Readonly<Record<string, readonly Row[]>> = {
  service_category: [
    { id: "c_classes", name: "Занятия", sort_order: 1 },
    { id: "c_courses", name: "Курсы и абонементы", sort_order: 2 },
    { id: "c_groups", name: "Для компаний", sort_order: 3 },
  ],
  service: [
    service(
      1,
      "Пробное занятие на круге",
      2500,
      120,
      "c_classes",
      "Два часа с мастером: центровка глины, первый цилиндр и чашка.",
    ),
    service(
      2,
      "Разовое занятие",
      3200,
      180,
      "c_classes",
      "Свободная практика на круге с подсказками мастера.",
    ),
    service(
      3,
      "Лепка для двоих",
      5400,
      150,
      "c_classes",
      "Один круг на двоих и общий набор посуды на память.",
    ),
    service(
      4,
      "Детское занятие",
      1800,
      90,
      "c_classes",
      "Ручная лепка для детей от семи лет, в группе до шести человек.",
      false,
    ),
    service(
      5,
      "Роспись готовой посуды",
      2200,
      120,
      "c_classes",
      "Расписываем обожжённые тарелки и чашки подглазурными красками.",
    ),
    service(
      6,
      "Курс «Основы гончарного дела»",
      19800,
      null,
      "c_courses",
      "Восемь занятий по три часа: от центровки до глазури и обжига.",
    ),
    service(
      7,
      "Курс ручной лепки",
      14400,
      null,
      "c_courses",
      "Шесть встреч: пласт, жгут, отминка в форму и декор.",
      false,
    ),
    service(
      8,
      "Интенсив выходного дня",
      9600,
      360,
      "c_courses",
      "Суббота и воскресенье на круге, обжиг работ включён.",
    ),
    service(
      9,
      "Абонемент на четыре занятия",
      11200,
      null,
      "c_courses",
      "Действует два месяца, занятия можно переносить.",
      false,
    ),
    service(
      10,
      "Корпоратив в мастерской",
      28000,
      180,
      "c_groups",
      "Зал целиком для команды до двенадцати человек.",
    ),
    service(
      11,
      "Мастер-класс на день рождения",
      16000,
      150,
      "c_groups",
      "Лепка, чай и упаковка работ для гостей.",
      false,
    ),
    service(
      12,
      "Глазурование своих работ",
      900,
      60,
      "c_classes",
      "Покрываем глазурью изделия после первого обжига.",
      false,
    ),
    service(
      13,
      "Обжиг одного изделия",
      500,
      null,
      "c_classes",
      "Для тех, кто лепит дома: принимаем работы по будням.",
      false,
    ),
    service(
      14,
      "Аренда круга на час",
      1200,
      60,
      "c_classes",
      "Для тех, кто уже уверенно работает на круге.",
      false,
    ),
  ],
  specialist: [
    { id: "m_olga", name: "Ольга, мастер круга", active: true },
    { id: "m_ilya", name: "Илья, ручная лепка", active: true },
  ],
  post: [
    post(
      1,
      "Как подготовиться к первому занятию",
      "2026-09-30",
      "Что надеть, нужно ли что-то приносить и почему ногти лучше подстричь заранее.",
    ),
    post(
      2,
      "Чем шамотная глина отличается от фарфоровой",
      "2026-09-18",
      "Разбираем три массы, с которыми работаем в мастерской, и когда какую выбирать.",
    ),
    post(
      3,
      "Новые вечерние группы в октябре",
      "2026-09-10",
      "Открыли запись на будни после семи вечера: две группы по шесть человек.",
    ),
    post(
      4,
      "Почему изделие трескается при сушке",
      "2026-08-27",
      "Сквозняк, толстое дно и спешка: как сохранить работу до обжига.",
      false,
    ),
    post(
      5,
      "Глазури: матовые, глянцевые и с эффектами",
      "2026-08-14",
      "Показываем тестовые плитки и рассказываем, как глазурь меняется в печи.",
    ),
    post(
      6,
      "Работы учеников на осенней выставке",
      "2026-07-30",
      "Двадцать предметов от чашек до больших ваз — фотографии с открытия.",
    ),
    post(
      7,
      "Как ухаживать за керамической посудой",
      "2026-07-12",
      "Можно ли в посудомойку и микроволновку и что делать с трещинками глазури.",
      false,
    ),
    post(
      8,
      "Гончарный круг дома: стоит ли покупать",
      "2026-06-25",
      "Сравниваем настольные и напольные круги и считаем, когда покупка окупится.",
    ),
    post(
      9,
      "Летний интенсив: что успели за пять дней",
      "2026-06-08",
      "От первых цилиндров до сервиза на четыре персоны.",
      false,
    ),
    post(
      10,
      "Мастерская переехала на Гончарную улицу",
      "2026-05-20",
      "Новый зал на втором этаже: шесть кругов, печь и большой стол для лепки.",
    ),
  ],
  // V3-24: rubrics and published articles of «Контент и блог» (the article patterns open «kak-podgotovitsya»).
  rubric: [
    {
      id: "r_start",
      name: "Новичкам",
      slug: "novichkam",
      description: "С чего начать на гончарном круге.",
      sort_order: 1,
    },
    {
      id: "r_glaze",
      name: "Глазури",
      slug: "glazuri",
      description: "Цвета, слои и обжиг.",
      sort_order: 2,
    },
  ],
  article: [
    article(
      1,
      "Как подготовиться к первому занятию",
      "kak-podgotovitsya",
      "2026-09-30",
      "r_start",
      "Что надеть, нужно ли что-то приносить и почему ногти лучше подстричь заранее.",
      [
        "Первое занятие длится **два часа**: мастер покажет центровку и поможет вытянуть первый цилиндр.",
        "",
        "## Что взять с собой",
        "",
        "- одежду, которую не жалко испачкать",
        "- резинку для волос",
        "- хорошее настроение",
        "",
        "> Глина любит спокойные руки: спешить не нужно.",
        "",
        "### Если опаздываете",
        "",
        "Напишите нам — подождём. Подробности на странице [занятий](/services) и в [карте](https://yandex.ru/maps).",
      ].join("\n"),
    ),
    article(
      2,
      "Матовая или глянцевая глазурь",
      "glazur",
      "2026-09-12",
      "r_glaze",
      "Показываем тестовые плитки и рассказываем, как глазурь меняется в печи.",
      "Матовая глазурь мягче на ощупь, глянцевая проще в уходе.",
      false,
    ),
    article(
      3,
      "Почему изделие трескается при сушке",
      "treshchiny",
      "2026-08-27",
      "r_start",
      "Сквозняк, толстое дно и спешка: как сохранить работу до обжига.",
      "Сушите изделие медленно, под плёнкой, вдали от батареи.",
    ),
  ],
};

/** How the stand-in answers: data as is, empty lists, errors of the runtime, or slow answers (loading states). */
export type PreviewMode = "ok" | "empty" | "error" | "slow";

/** A write the page sent (POST /api/data/:entity, /api/fn/:name): the body as the runtime got it. */
export interface PreviewWrite {
  path: string;
  body: Record<string, unknown>;
}

const PHONE_RE = /^\+7\d{10}$/;
/** A phone the stand-in refuses with a field error (server validation of a lead form). */
export const PREVIEW_TAKEN_PHONE = "+79990000000";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c: Buffer) => {
      s += c.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(s ? (JSON.parse(s) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Rows of a list query of the data API: filter[f]=v equality, sort (-field), page and limit. */
function listRows(
  rows: readonly Row[],
  q: URLSearchParams,
): { items: Row[]; total: number; page: number; limit: number } {
  let out = rows.filter((r) => {
    for (const [k, v] of q) {
      const m = /^filter\[(\w+)\]$/.exec(k);
      if (m && String(r[m[1] as string] ?? "") !== v) return false;
    }
    return true;
  });
  const sort = q.get("sort");
  if (sort) {
    const desc = sort.startsWith("-");
    const f = desc ? sort.slice(1) : sort;
    out = [...out].sort((a, b) => {
      const x = a[f] as string | number | null;
      const y = b[f] as string | number | null;
      const c =
        x === y ? 0 : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : x < y ? -1 : 1;
      return desc ? -c : c;
    });
  }
  const limit = Math.min(Number(q.get("limit") ?? 20), 100);
  const page = Math.max(Number(q.get("page") ?? 1), 1);
  return { items: out.slice((page - 1) * limit, page * limit), total: out.length, page, limit };
}

/**
 * The runtime endpoints of the preview: GET/POST /api/data/:entity, POST /api/fn/busySlots, GET /api/events (an SSE
 * stream that stays open), GET /api/files/:id/img/:width (served by `photo`), GET /api/auth/me. Writes are recorded;
 * a booking takes its time. Returns false for any other path.
 */
export function previewApi(photo: (name: string) => string) {
  const created = new Map<string, Row[]>();
  const writes: PreviewWrite[] = [];
  const streams = new Set<ServerResponse>();
  let mode: PreviewMode = "ok";
  let seq = 0;

  const rowsOf = (entity: string): Row[] => [...(PREVIEW_ROWS[entity] ?? []), ...(created.get(entity) ?? [])];

  const busySlots = (args: Record<string, unknown>) => {
    const from = Date.parse(String(args.from ?? ""));
    const to = Date.parse(String(args.to ?? ""));
    if (Number.isNaN(from) || Number.isNaN(to)) return [];
    const day = new Date(from + 12 * 3_600_000).toISOString().slice(0, 10);
    const at = (h: number) => new Date(zonedAt(PREVIEW_SCHEDULE.tz, day, h * 60)).toISOString();
    // Two times of every working day are taken; bookings of the page take theirs.
    const fixed = [11, 16].map((h) => ({ starts_at: at(h), ends_at: at(h + 1), seat: 1 }));
    const booked = rowsOf("booking")
      .filter((b) => {
        const t = Date.parse(String(b.starts_at));
        return t >= from && t < to && (!args.specialist || b.specialist === args.specialist);
      })
      .map((b) => ({ starts_at: String(b.starts_at), ends_at: String(b.ends_at), seat: 1 }));
    return [...fixed, ...booked];
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const path = decodeURIComponent(url.pathname);
    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": preview\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return true;
    }
    if (path === "/api/auth/me") {
      json(res, 200, { user: null });
      return true;
    }
    const img = /^\/api\/files\/([\w.-]+)\/img\/\d+$/.exec(path);
    if (img) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(photo(img[1] as string));
      return true;
    }
    const data = /^\/api\/data\/(\w+)$/.exec(path);
    const fn = /^\/api\/fn\/(\w+)$/.exec(path);
    if (!data && !fn) return false;
    const body = req.method === "POST" ? await readBody(req) : {};
    if (mode === "slow") await new Promise((r) => setTimeout(r, 1200));
    if (mode === "error" && req.method === "GET") {
      json(res, 500, { error: { code: "INTERNAL", message: "Внутренняя ошибка" } });
      return true;
    }
    if (data && req.method === "GET") {
      const entity = data[1] as string;
      const page = listRows(mode === "empty" ? [] : rowsOf(entity), url.searchParams);
      json(res, 200, { ...page, hasMore: page.page * page.limit < page.total });
      return true;
    }
    if (data && req.method === "POST") {
      const entity = data[1] as string;
      writes.push({ path, body });
      const { _consent, ...doc } = body;
      if (doc.phone === PREVIEW_TAKEN_PHONE || (typeof doc.phone === "string" && !PHONE_RE.test(doc.phone))) {
        json(res, 422, {
          error: {
            code: "VALIDATION_FAILED",
            message: "Проверьте поля формы",
            details: {
              fields: [{ field: "phone", code: "TAKEN", message: "Заявка с этим номером уже принята" }],
            },
          },
        });
        return true;
      }
      // The unique time-and-seat index of «Запись по слотам»: a time booked meanwhile is a CONFLICT.
      const taken = (b: Row) =>
        b.starts_at === doc.starts_at && (b.specialist ?? null) === (doc.specialist ?? null);
      if (entity === "booking" && rowsOf("booking").some(taken)) {
        json(res, 409, { error: { code: "CONFLICT", message: "Это время уже занято" } });
        return true;
      }
      if (_consent === undefined && ["lead", "booking"].includes(entity)) {
        json(res, 403, {
          error: { code: "CONSENT_REQUIRED", message: "Нужно согласие на обработку персональных данных" },
        });
        return true;
      }
      seq += 1;
      const item: Row = { id: `${entity}_${seq}`, status: "new", ...doc };
      created.set(entity, [...(created.get(entity) ?? []), item]);
      json(res, 201, { item });
      return true;
    }
    if (fn && req.method === "POST") {
      const name = fn[1] as string;
      const args = (body.args ?? {}) as Record<string, unknown>;
      if (name !== "busySlots") writes.push({ path, body });
      json(res, 200, {
        result: name === "busySlots" ? (mode === "empty" ? [] : busySlots(args)) : null,
        deps: [],
      });
      return true;
    }
    json(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Метод не поддерживается" } });
    return true;
  };

  return {
    handle,
    writes,
    setMode(m: PreviewMode) {
      mode = m;
    },
    /** Ends the open SSE streams (before the server closes). */
    close() {
      for (const s of streams) s.end();
      streams.clear();
    },
  };
}
