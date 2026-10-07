// B2-37 recorded design answers on the ten mvp briefs (tools/eval/briefs/mvp-*.json): the plan each brief gets from
// the planner (after the texts stage) and the submit_design answer a model gives on it. design-direction.test.ts turns
// them into tools/fixtures/demo/b2/design-<brief>.jsonl (one build_design line each, usage counted from the real
// prompt) and measures the diversity of the directions. No models are called.
import type { PlanSection, SystemPlan } from "@wizard/appspec";
import type { DesignInput } from "../src/builder/index.js";

export interface DesignScenario {
  /** Brief id in tools/eval/briefs. */
  brief: string;
  plan: SystemPlan;
  design: DesignInput;
}

const sec = (type: string, variant: string, content: PlanSection["content"] = {}): PlanSection => ({
  type,
  variant,
  content,
});
const header = (cta: string) => sec("header", "bar", { cta });
const footer = (text: string) => sec("footer", "simple", { text });

/** Planner design before the design stage: the default the planner writes when it says nothing about design. */
const PLANNER_DESIGN: SystemPlan["design"] = {
  direction: { mood: ["современно"] },
  theme: "strict",
  accent: "#1F4FB8",
  fontPair: { heading: "Manrope", body: "IBM Plex Sans" },
  photoStyle: "деловая среда при дневном свете",
};

const plan = (p: Pick<SystemPlan, "niche" | "goals" | "modules"> & Partial<SystemPlan>): SystemPlan => ({
  version: 1,
  design: PLANNER_DESIGN,
  outOfScope: [],
  custom: [],
  ...p,
});

export const DESIGN_SCENARIOS: readonly DesignScenario[] = [
  {
    brief: "mvp-01-dental-clinic",
    plan: plan({
      niche: "стоматологическая клиника",
      goals: [
        { id: "leads", statement: "Пациенты оставляют заявку на консультацию" },
        { id: "show_offer", statement: "Пациенты видят услуги клиники" },
        { id: "stay_informed", statement: "Заявки сразу приходят на почту и в Telegram" },
      ],
      modules: [
        { id: "landing" },
        { id: "catalog", goals: ["show_offer"] },
        { id: "leads", params: { contact: "phone" }, goals: ["leads"] },
        { id: "notify", params: { channels: ["email", "telegram"] }, goals: ["stay_informed"] },
      ],
      landing: {
        sections: [
          header("Записаться на консультацию"),
          sec("hero", "split", {
            title: "Лечим, имплантируем и отбеливаем зубы в Казани",
            subtitle: "Оставьте заявку — администратор перезвонит и подберёт время консультации",
            cta: "Записаться на консультацию",
          }),
          sec("services", "list", { title: "Услуги клиники" }),
          sec("features", "cards", {
            title: "Для всей семьи",
            items: ["Лечение и имплантация", "Отбеливание", "Детский врач"],
          }),
          sec("lead_form", "card", { title: "Заявка на консультацию", submit_label: "Отправить" }),
          footer("Стоматология, Казань"),
        ],
      },
    }),
    design: {
      direction: { mood: ["бережность", "чистота", "доверие"], rhythm: "airy", voice: "calm" },
      theme: "care",
      accent: "#1D6A8A",
      fontPair: { heading: "Wix Madefor Display", body: "Wix Madefor Text" },
      photoStyle:
        "светлый кабинет при дневном свете, врач спокойно объясняет пациенту, без масок крупным планом",
      sections: [{ index: 3, variant: "grid" }],
    },
  },
  {
    brief: "mvp-02-renovation",
    plan: plan({
      niche: "ремонт квартир под ключ",
      goals: [
        { id: "leads", statement: "Получать заявки на замер с сайта" },
        { id: "attract", statement: "Показать этапы работ и фото объектов" },
      ],
      modules: [
        { id: "landing", goals: ["attract"] },
        { id: "leads", params: { contact: "phone" }, goals: ["leads"] },
        { id: "notify" },
      ],
      landing: {
        sections: [
          header("Вызвать замерщика"),
          sec("hero", "split", {
            title: "Ремонт квартир под ключ",
            subtitle: "Замер, смета, работы и сдача объекта — всё делаем сами",
            cta: "Вызвать замерщика",
          }),
          sec("steps", "numbered", {
            title: "Этапы работ",
            items: ["Замер", "Смета", "Черновые работы", "Чистовая отделка", "Сдача объекта"],
          }),
          sec("gallery", "grid", { title: "Наши объекты" }),
          sec("lead_form", "split", { title: "Заявка на замер", submit_label: "Отправить" }),
          footer("Ремонт квартир под ключ"),
        ],
      },
    }),
    design: {
      direction: { mood: ["крепко", "по делу", "аккуратно"], rhythm: "dense", voice: "bold" },
      theme: "workshop",
      accent: "#A3410F",
      fontPair: { heading: "Sofia Sans Extra Condensed", body: "Sofia Sans" },
      photoStyle: "готовые комнаты после ремонта при дневном свете, фактуры дерева и камня, детали отделки",
      sections: [
        { index: 1, variant: "cover" },
        { index: 3, variant: "masonry", band: "alt" },
      ],
    },
  },
  {
    brief: "mvp-03-english-courses",
    plan: plan({
      niche: "онлайн-курсы английского для взрослых",
      goals: [
        { id: "leads", statement: "Записывать на пробный урок" },
        { id: "show_offer", statement: "Показать тарифы курсов" },
      ],
      modules: [
        { id: "landing" },
        { id: "catalog", params: { item_label: "Тариф" }, goals: ["show_offer"] },
        { id: "leads", params: { contact: "email" }, goals: ["leads"] },
        { id: "notify" },
      ],
      landing: {
        sections: [
          header("Пробный урок"),
          sec("hero", "split", {
            title: "Английский для взрослых онлайн",
            subtitle: "Начните с пробного урока — подберём группу по уровню",
            cta: "Записаться на пробный урок",
          }),
          sec("features", "cards", {
            title: "Как проходят занятия",
            items: ["Онлайн из дома", "Группы по уровню", "Разговорная практика"],
          }),
          sec("pricing", "cards", { title: "Тарифы" }),
          sec("faq", "accordion", {
            title: "Частые вопросы",
            items: [
              { question: "Как проходит пробный урок?", answer: "Онлайн, преподаватель определит уровень." },
            ],
          }),
          sec("lead_form", "card", { title: "Запись на пробный урок", submit_label: "Записаться" }),
          footer("Курсы английского онлайн"),
        ],
      },
    }),
    design: {
      direction: { mood: ["дружелюбно", "понятно", "вдохновляет"], rhythm: "balanced", voice: "friendly" },
      theme: "academy",
      accent: "#2A5DA8",
      fontPair: { heading: "Alegreya Sans", body: "Alegreya" },
      photoStyle: "взрослые на онлайн-занятии дома, ноутбук, живые эмоции разговора, мягкий дневной свет",
      sections: [{ index: 1, variant: "centered" }],
    },
  },
  {
    brief: "mvp-04-beauty-salon",
    plan: plan({
      niche: "салон красоты",
      goals: [
        { id: "fill_schedule", statement: "Клиенты сами выбирают мастера, услугу и время" },
        { id: "reduce_no_shows", statement: "Напоминание клиенту за день" },
        { id: "team_work", statement: "Мастер видит только свои записи" },
      ],
      modules: [
        { id: "landing" },
        { id: "catalog", params: { with_duration: true } },
        {
          id: "booking",
          params: { with_specialists: true, specialist_label: "Мастер" },
          goals: ["fill_schedule"],
        },
        { id: "notify", goals: ["reduce_no_shows"] },
        { id: "staff", goals: ["team_work"] },
      ],
      landing: {
        sections: [
          header("Записаться"),
          sec("hero", "split", {
            title: "Маникюр, стрижки и брови",
            subtitle: "Выберите мастера и удобное время онлайн",
            cta: "Записаться",
          }),
          sec("services", "list", { title: "Услуги и цены" }),
          sec("booking", "card", { title: "Онлайн-запись" }),
          footer("Салон красоты"),
        ],
      },
    }),
    design: {
      direction: { mood: ["изящно", "спокойно", "ухоженно"], rhythm: "airy", voice: "refined" },
      theme: "boutique",
      accent: "#7A2E4A",
      fontPair: { heading: "Cormorant Garamond", body: "Commissioner" },
      photoStyle: "руки мастера и детали работы крупным планом, студийный рассеянный свет, однотонный фон",
      sections: [{ index: 3, variant: "split" }],
    },
  },
  {
    brief: "mvp-05-psychologist",
    plan: plan({
      niche: "психолог",
      goals: [
        { id: "fill_schedule", statement: "Клиенты записываются на сеансы по 50 минут" },
        { id: "reduce_no_shows", statement: "Клиент может отменить запись по ссылке" },
      ],
      modules: [
        { id: "landing" },
        { id: "catalog", params: { with_duration: true } },
        { id: "booking", goals: ["fill_schedule"] },
        { id: "notify", goals: ["reduce_no_shows"] },
      ],
      landing: {
        sections: [
          header("Записаться на сеанс"),
          sec("hero", "split", {
            title: "Консультации психолога",
            subtitle: "Сеанс 50 минут, понедельник — пятница",
            cta: "Записаться на сеанс",
          }),
          sec("about", "split", {
            title: "Как я работаю",
            text: "Встречи проходят в спокойном темпе. Всё, что вы рассказываете, остаётся между нами.",
          }),
          sec("steps", "numbered", {
            title: "Как записаться",
            items: ["Выберите время", "Получите подтверждение", "Отменить можно по ссылке из письма"],
          }),
          sec("booking", "card", { title: "Свободное время" }),
          footer("Психологическое консультирование"),
        ],
      },
    }),
    design: {
      direction: { mood: ["тишина", "принятие", "опора"], rhythm: "airy", voice: "calm" },
      theme: "calm",
      accent: "#3F6B5C",
      fontPair: { heading: "Literata", body: "Source Sans 3" },
      photoStyle: "уютный светлый кабинет, кресла и растения, рассеянный свет, без людей в кадре",
      sections: [{ index: 2, variant: "story" }],
    },
  },
  {
    brief: "mvp-06-meeting-room",
    plan: plan({
      niche: "коворкинг: аренда переговорной",
      goals: [
        { id: "fill_schedule", statement: "Почасовая бронь переговорной без пересечений" },
        { id: "stay_informed", statement: "Админ подтверждает бронь" },
      ],
      modules: [
        { id: "landing" },
        { id: "catalog", params: { with_duration: true, item_label: "Переговорная" } },
        { id: "booking", goals: ["fill_schedule"] },
        { id: "notify", goals: ["stay_informed"] },
      ],
      landing: {
        sections: [
          header("Забронировать"),
          sec("hero", "split", {
            title: "Переговорная по часам",
            subtitle: "Выберите свободное время — администратор подтвердит бронь",
            cta: "Забронировать",
          }),
          sec("features", "cards", {
            title: "Что внутри",
            items: ["Экран для презентаций", "Стол на 8 человек", "Кофе и вода"],
          }),
          sec("booking", "card", { title: "Свободные часы" }),
          sec("hours", "table", { items: [{ day: "Пн–Пт", time: "9:00–21:00" }] }),
          footer("Коворкинг"),
        ],
      },
    }),
    design: {
      direction: { mood: ["энергично", "современно"], rhythm: "dense", voice: "bold" },
      theme: "bright",
      accent: "#0F6B6B",
      fontPair: { heading: "Unbounded", body: "Onest" },
      photoStyle: "светлая переговорная с людьми за работой, живой момент обсуждения, насыщенный цвет",
      sections: [{ index: 2, variant: "grid" }],
    },
  },
  {
    brief: "mvp-07-realty-crm",
    plan: plan({
      niche: "агентство недвижимости",
      goals: [
        { id: "client_history", statement: "Клиенты и объекты в одном месте" },
        { id: "deal_pipeline", statement: "Сделки по этапам воронки" },
        { id: "team_work", statement: "Руководитель видит всё, менеджер только своё" },
      ],
      modules: [
        { id: "client_card", goals: ["client_history"] },
        { id: "deals", goals: ["deal_pipeline"] },
        { id: "staff", goals: ["team_work"] },
      ],
    }),
    design: {
      direction: { mood: ["порядок", "надёжность"], rhythm: "dense", voice: "formal" },
      theme: "strict",
      accent: "#1E4E8C",
      fontPair: { heading: "Manrope", body: "IBM Plex Sans" },
      photoStyle: "светлые квартиры и дома при дневном свете, без людей",
    },
  },
  {
    brief: "mvp-08-repair-shop",
    plan: plan({
      niche: "мастерская по ремонту техники",
      goals: [
        { id: "deal_pipeline", statement: "Статусы ремонта от приёма до выдачи" },
        { id: "stay_informed", statement: "Клиенту письмо, когда техника готова" },
        { id: "visibility", statement: "Отчёт по выручке за месяц" },
      ],
      modules: [
        { id: "client_card" },
        { id: "deals", goals: ["deal_pipeline"] },
        { id: "notify", goals: ["stay_informed"] },
        { id: "reports", goals: ["visibility"] },
      ],
    }),
    design: {
      direction: { mood: ["чётко", "технично"], rhythm: "balanced", voice: "formal" },
      theme: "workshop",
      accent: "#C2410C",
      fontPair: { heading: "Inter Tight", body: "PT Sans" },
      photoStyle: "рабочий стол мастера, платы и инструменты крупным планом, контрастный боковой свет",
    },
  },
  {
    brief: "mvp-09-school-library",
    plan: plan({
      niche: "школьная библиотека",
      goals: [
        { id: "resource_tracking", statement: "Кто взял какую книгу и когда вернёт" },
        { id: "reduce_no_shows", statement: "Напоминание ученику о сроке возврата" },
      ],
      modules: [
        { id: "resources", goals: ["resource_tracking"] },
        { id: "notify", goals: ["reduce_no_shows"] },
      ],
    }),
    design: {
      direction: { mood: ["уютно", "по-школьному"], rhythm: "balanced", voice: "friendly" },
      theme: "academy",
      accent: "#7A4A12",
      fontPair: { heading: "PT Serif", body: "PT Sans" },
      photoStyle:
        "книжные полки и читальный зал при дневном свете, ученики за чтением без лиц крупным планом",
    },
  },
  {
    brief: "mvp-10-yoga-subscription",
    plan: plan({
      niche: "онлайн-школа йоги",
      goals: [
        { id: "retention", statement: "Подписка на видеоуроки" },
        { id: "self_service", statement: "Личный кабинет ученика" },
      ],
      modules: [
        { id: "landing" },
        { id: "catalog", params: { with_duration: true, item_label: "Занятие" } },
        { id: "booking" },
        { id: "notify" },
        { id: "client_card" },
        { id: "packages", goals: ["retention"] },
        { id: "visitor_cabinet", goals: ["self_service"] },
      ],
      landing: {
        sections: [
          header("Выбрать подписку"),
          sec("hero", "split", {
            title: "Йога дома по видеоурокам",
            subtitle: "Подписка на все уроки и личный кабинет ученика",
            cta: "Выбрать подписку",
          }),
          sec("features", "cards", {
            title: "Что входит",
            items: ["Видеоуроки для начинающих и продолжающих", "Занятия в удобное время", "Личный кабинет"],
          }),
          sec("pricing", "cards", { title: "Подписка" }),
          sec("faq", "accordion", {
            title: "Вопросы",
            items: [{ question: "Можно ли начать без опыта?", answer: "Да, есть уроки для начинающих." }],
          }),
          footer("Онлайн-школа йоги"),
        ],
      },
      outOfScope: [
        {
          request: "Оплата картой каждый месяц",
          replacement: "Подписку продаёт владелец, оплата — по реквизитам",
          category: "payments",
        },
      ],
    }),
    design: {
      direction: { mood: ["тепло", "мягко", "дыхание"], rhythm: "airy", voice: "warm" },
      theme: "warm",
      accent: "#9A4A2A",
      fontPair: { heading: "Lora", body: "Golos Text" },
      photoStyle: "занятие дома на коврике, тёплый утренний свет из окна, растения и мягкие ткани",
      sections: [
        { index: 2, variant: "alternating" },
        { index: 3, variant: "compact", band: "alt" },
      ],
    },
  },
];
