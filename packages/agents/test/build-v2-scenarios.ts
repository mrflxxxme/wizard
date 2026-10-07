// B2-21 recorded scenarios of the modules pipeline: brief → goals analysis (no questions) → system plan → texts →
// design, as a model answers them. build-v2.fixtures.test.ts turns them into tools/fixtures/demo/b2/<name>.jsonl
// (suite demo: answers by the order of each callType) with usage counted from the real prompts.
import type { SystemPlan } from "@wizard/appspec";
import type { CustomInput, DesignInput, TextsInput } from "../src/builder/index.js";
import type { GoalsAnalysis } from "../src/planner/index.js";
import { DENTAL_BRIEF, dentalAnalysis, dentalPlan } from "./planner-helpers.js";

export interface B2Scenario {
  name: string;
  title: string;
  brief: string;
  analysis: GoalsAnalysis;
  /** submit_plan arguments. */
  plan: SystemPlan;
  texts: TextsInput;
  design: DesignInput;
}

const dental: B2Scenario = {
  name: "dental",
  title: "Стоматология: заявки с сайта",
  brief: DENTAL_BRIEF,
  analysis: dentalAnalysis({ questions: [] }),
  plan: dentalPlan(),
  texts: {
    sections: [
      {
        index: 1,
        content: {
          title: "Лечим зубы бережно и без боли",
          subtitle: "Оставьте заявку — администратор перезвонит за 15 минут и подберёт время",
          cta: "Записаться на приём",
        },
      },
      {
        index: 2,
        content: {
          title: "Почему пациенты выбирают нас",
          items: ["Современное оборудование в каждом кабинете", "Лечение под местной анестезией"],
        },
      },
    ],
  },
  design: {
    direction: { mood: ["спокойствие", "чистота", "доверие"], rhythm: "airy", voice: "calm" },
    theme: "calm",
    accent: "#2A7F9E",
    fontPair: { heading: "PT Serif", body: "PT Sans" },
    photoStyle: "светлые кабинеты при дневном свете, врач и пациент в спокойной беседе",
    sections: [{ index: 2, variant: "grid" }],
  },
};

const BARBER_BRIEF =
  "Барбершоп в Самаре, три мастера. Хотим, чтобы клиенты сами записывались на свободное время к мастеру, видели " +
  "услуги и цены, а накануне визита им приходило напоминание. Мастерам и администратору — письмо о новой записи.";

const barber: B2Scenario = {
  name: "barber",
  title: "Барбершоп: онлайн-запись к мастеру",
  brief: BARBER_BRIEF,
  analysis: {
    niche: "барбершоп",
    goals: [
      { id: "fill_schedule", statement: "Клиенты сами записываются на свободное время к мастеру" },
      { id: "reduce_no_shows", statement: "Клиенту приходит напоминание накануне визита" },
      { id: "show_offer", statement: "Клиенты видят услуги и цены" },
    ],
    roles: ["Администратор", "Мастер"],
    resources: ["мастера", "услуги"],
    modules: [
      { id: "landing", why: "страница барбершопа" },
      { id: "catalog", why: "услуги и цены" },
      { id: "booking", why: "запись на время к мастеру" },
      { id: "notify", why: "напоминание и письмо о записи" },
    ],
    outOfScope: [],
    questions: [],
  },
  plan: {
    version: 1,
    niche: "барбершоп",
    goals: [
      { id: "fill_schedule", statement: "Клиенты сами записываются на свободное время к мастеру" },
      { id: "reduce_no_shows", statement: "Клиенту приходит напоминание накануне визита" },
      { id: "show_offer", statement: "Клиенты видят услуги и цены" },
    ],
    modules: [
      { id: "landing" },
      { id: "catalog", params: { with_duration: true }, goals: ["show_offer"] },
      {
        id: "booking",
        params: { with_specialists: true, specialist_label: "Мастер" },
        goals: ["fill_schedule"],
      },
      { id: "notify", params: { channels: ["email"] }, goals: ["reduce_no_shows"] },
    ],
    landing: {
      sections: [
        { type: "header", variant: "bar", content: { cta: "Записаться" } },
        {
          type: "hero",
          variant: "cover",
          content: {
            title: "Стрижки и бритьё в Самаре",
            subtitle: "Запишитесь онлайн к своему мастеру",
            cta: "Записаться",
          },
        },
        { type: "services", variant: "table", content: { title: "Услуги и цены" } },
        {
          type: "steps",
          variant: "numbered",
          content: {
            title: "Как записаться",
            items: ["Выберите услугу", "Выберите мастера и время", "Получите напоминание накануне"],
          },
        },
        { type: "footer", variant: "simple", content: { text: "Пример: барбершоп, Самара" } },
      ],
    },
    design: {
      direction: { mood: ["брутально", "уверенно"], rhythm: "balanced" },
      theme: "strict",
      accent: "#1F4FB8",
      fontPair: { heading: "Manrope", body: "Inter Tight" },
      photoStyle: "мастер за работой, тёплый свет, крупный план",
    },
    outOfScope: [],
    custom: [],
  },
  texts: {
    sections: [
      {
        index: 1,
        content: {
          title: "Стрижки и бритьё в Самаре",
          subtitle: "Выберите мастера и удобное время — запись займёт минуту",
          cta: "Записаться онлайн",
        },
      },
      {
        index: 3,
        content: {
          title: "Запись в три шага",
          items: ["Выберите услугу", "Выберите мастера и свободное время", "Накануне придёт напоминание"],
        },
      },
    ],
  },
  design: {
    direction: { mood: ["мужской", "уверенный", "ремесло"], rhythm: "dense", voice: "bold" },
    theme: "workshop",
    accent: "#8C2F1B",
    fontPair: { heading: "Sofia Sans Extra Condensed", body: "Sofia Sans" },
    photoStyle: "мастер с клиентом в кресле, тёплый вечерний свет, дерево и кожа",
    sections: [{ index: 1, variant: "cover" }],
  },
};

const REPAIR_BRIEF =
  "Бригада по ремонту квартир в Екатеринбурге. Нужно принимать заявки с сайта, вести карточки клиентов с историей " +
  "и видеть, на каком этапе каждый объект: замер, смета, работы, сдача. И чтобы мы сразу узнавали о новой заявке. " +
  "Ещё хотим расчёт сметы прямо на сайте.";

const repair: B2Scenario = {
  name: "repair",
  title: "Ремонт квартир: заявки, клиенты и воронка",
  brief: REPAIR_BRIEF,
  analysis: {
    niche: "ремонт квартир",
    goals: [
      { id: "leads", statement: "Принимать заявки с сайта и не терять их" },
      { id: "client_history", statement: "Карточки клиентов с историей" },
      { id: "deal_pipeline", statement: "Видеть, на каком этапе каждый объект" },
    ],
    roles: ["Владелец"],
    resources: ["объекты", "клиенты"],
    modules: [
      { id: "landing", why: "страница бригады" },
      { id: "leads", why: "заявки с сайта" },
      { id: "client_card", why: "клиенты с историей" },
      { id: "deals", why: "этапы объектов" },
      { id: "notify", why: "письмо о новой заявке" },
    ],
    outOfScope: [{ request: "расчёт сметы на сайте", category: "other" }],
    questions: [],
  },
  plan: {
    version: 1,
    niche: "ремонт квартир",
    goals: [
      { id: "leads", statement: "Принимать заявки с сайта и не терять их" },
      { id: "client_history", statement: "Карточки клиентов с историей" },
      { id: "deal_pipeline", statement: "Видеть, на каком этапе каждый объект" },
    ],
    modules: [
      { id: "landing" },
      { id: "leads", params: { contact: "phone" }, goals: ["leads"] },
      { id: "client_card", goals: ["client_history"] },
      { id: "deals", goals: ["deal_pipeline"] },
      { id: "notify", params: { channels: ["email"] } },
    ],
    landing: {
      sections: [
        { type: "header", variant: "bar", content: { cta: "Оставить заявку" } },
        {
          type: "hero",
          variant: "split",
          content: {
            title: "Ремонт квартир под ключ",
            subtitle: "Приедем на замер и составим смету",
            cta: "Оставить заявку",
          },
        },
        {
          type: "steps",
          variant: "timeline",
          content: { title: "Как мы работаем", items: ["Замер", "Смета", "Работы", "Сдача объекта"] },
        },
        {
          type: "faq",
          variant: "accordion",
          content: { title: "Вопросы", items: [{ q: "Сколько стоит замер?", a: "Пример: замер бесплатно" }] },
        },
        {
          type: "lead_form",
          variant: "split",
          content: { title: "Оставьте заявку на замер", submit_label: "Отправить" },
        },
        { type: "footer", variant: "simple", content: { text: "Пример: ремонт квартир, Екатеринбург" } },
      ],
    },
    design: {
      direction: { mood: ["надёжность", "порядок"], rhythm: "balanced" },
      theme: "strict",
      accent: "#1F4FB8",
      fontPair: { heading: "Manrope", body: "IBM Plex Sans" },
      photoStyle: "светлая квартира после ремонта, дневной свет",
    },
    outOfScope: [
      {
        request: "Расчёт сметы на сайте",
        replacement: "Заявка на замер, смету присылаем после замера",
        category: "custom_logic",
        module: "leads",
      },
    ],
    custom: [],
  },
  texts: {
    sections: [
      {
        index: 1,
        content: {
          title: "Ремонт квартир под ключ",
          subtitle: "Приедем на замер, составим смету и сдадим объект в срок, о котором договоримся",
          cta: "Вызвать замерщика",
        },
      },
      {
        index: 4,
        content: { title: "Запишитесь на замер", submit_label: "Отправить заявку" },
      },
    ],
  },
  design: {
    direction: { mood: ["надёжность", "аккуратность"], rhythm: "balanced", voice: "formal" },
    theme: "strict",
    accent: "#1F4FB8",
    fontPair: { heading: "Manrope", body: "IBM Plex Sans" },
    photoStyle: "чистая квартира после ремонта, дневной свет, без людей",
    sections: [{ index: 2, variant: "numbered" }],
  },
};

export const B2_SCENARIOS: readonly B2Scenario[] = [dental, barber, repair];

// ---------------------------------------------------------------- B2-23: custom code
/** A scenario with custom parts in its plan and the recorded submit_custom answers, one per round (first, fix 1, fix 2). */
export interface B2CustomScenario extends B2Scenario {
  rounds: CustomInput[];
}

/** The dental plan with a small custom screen and a custom function (within the D76 limits). */
export function dentalCustomPlan(): SystemPlan {
  return {
    ...dentalPlan(),
    custom: [
      {
        id: "price_quiz",
        title: "Подбор лечения",
        kind: "screen",
        description: "Экран с тремя вопросами, который подсказывает пациенту, с какой услуги начать",
        budgetRub: 8,
        goal: "attract",
      },
      {
        id: "leads_month",
        title: "Заявки за месяц",
        kind: "function",
        description:
          "Функция для владельца: сколько заявок пришло за последние 30 дней и сколько из них ещё новые",
        budgetRub: 6,
        module: "leads",
        goal: "leads",
      },
    ],
  };
}

/** The custom screen: three questions and advice where to start, no data and no personal data. */
export const QUIZ_SCREEN = `import { useState } from "@wizard/sdk";
import { AppShell, Button } from "@wizard/ui-kit";

const STEPS = [
  { question: "Что беспокоит сейчас?", answers: ["Болит зуб", "Ничего не болит"] },
  { question: "Когда вы были у стоматолога?", answers: ["Меньше года назад", "Больше года назад"] },
  { question: "Что для вас важнее?", answers: ["Убрать боль", "Красивая улыбка"] },
];

function adviceOf(answers: number[]): string {
  if (answers[0] === 0 || answers[2] === 0)
    return "Начните с консультации терапевта: врач найдёт причину боли и составит план лечения.";
  if (answers[1] === 1) return "Начните с осмотра и профессиональной чистки — врач проверит зубы и подскажет, что дальше.";
  return "Начните с консультации: врач расскажет, как сделать улыбку красивее.";
}

export default function CustomPriceQuiz() {
  const [answers, setAnswers] = useState<number[]>([]);
  const step = STEPS[answers.length];
  return (
    <AppShell title="Подбор лечения">
      <section>
        {step ? (
          <>
            <p>
              Вопрос {answers.length + 1} из {STEPS.length}
            </p>
            <h2>{step.question}</h2>
            {step.answers.map((a, i) => (
              <Button key={a} variant="secondary" onClick={() => setAnswers([...answers, i])}>
                {a}
              </Button>
            ))}
          </>
        ) : (
          <>
            <h2>С чего начать</h2>
            <p>{adviceOf(answers)}</p>
            <Button href="/" variant="primary">
              Оставить заявку
            </Button>
            <Button variant="ghost" onClick={() => setAnswers([])}>
              Пройти ещё раз
            </Button>
          </>
        )}
      </section>
    </AppShell>
  );
}
`;

/** The custom function: leads of the last 30 days and the new ones among them (owner only). */
export const LEADS_MONTH_FN = `import { query, v } from "@wizard/sdk";

const DAY = 86_400_000;

export default query({
  args: { days: v.optional(v.int({ min: 1, max: 90 })) },
  handler: async (ctx, args) => {
    const since = ctx.now.getTime() - (args.days ?? 30) * DAY;
    const rows = await ctx.db.lead.list({ order: "desc", limit: 100 });
    const recent = rows.filter((r) => Date.parse(String(r.created_at)) >= since);
    return { total: recent.length, fresh: recent.filter((r) => r.status === "new").length };
  },
});
`;

/** The same function the way a model guesses the Convex API: G0-TS-01 every time. */
export const LEADS_MONTH_BROKEN = `import { query, v } from "@wizard/sdk";

export default query({
  args: { days: v.optional(v.int({ min: 1, max: 90 })) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("lead").collect();
    return { total: rows.length, days: args.days ?? 30 };
  },
});
`;

const quiz = { id: "price_quiz", roles: ["guest", "owner"], nav: true, code: QUIZ_SCREEN };
const leadsMonth = (code: string) => ({ id: "leads_month", roles: ["owner"], kind: "query" as const, code });

/** Both parts are right the first time. */
const dentalCustom: B2CustomScenario = {
  ...dental,
  name: "dental_custom",
  title: "Стоматология: заявки и подбор лечения (дописывание)",
  plan: dentalCustomPlan(),
  rounds: [{ items: [quiz, leadsMonth(LEADS_MONTH_FN)] }],
};

/** The function stays broken after 2 rounds of fixes: the system comes out with the screen and without the function. */
const dentalCustomBroken: B2CustomScenario = {
  ...dentalCustom,
  name: "dental_custom_broken",
  title: "Стоматология: дописанная функция не проходит проверку",
  rounds: [
    { items: [quiz, leadsMonth(LEADS_MONTH_BROKEN)] },
    { items: [leadsMonth(LEADS_MONTH_BROKEN)] },
    { items: [leadsMonth(LEADS_MONTH_BROKEN)] },
  ],
};

export const B2_CUSTOM_SCENARIOS: readonly B2CustomScenario[] = [dentalCustom, dentalCustomBroken];
