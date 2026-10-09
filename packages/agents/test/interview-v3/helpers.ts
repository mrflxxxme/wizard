// V3-03 test fixtures: four briefs of the v3 classes (business site, booking, CRM, shop), a scripted model of the
// interview_v3 route (each call gets the next scripted answer; a function sees the request) and a recorder that turns
// the calls into fixture lines for the fixture router.
import type { LlmMessage, LlmTool, RouteInput, RouteOutput } from "@wizard/llm";

/** A model answer: tool calls, plain text (no tool call) or an error thrown by the route. */
export type ScriptedAnswer = { name: string; args: unknown }[] | string | Error;
export type ScriptStep = ScriptedAnswer | ((input: RouteInput, n: number) => ScriptedAnswer);

export interface RecordedCall {
  messages: LlmMessage[];
  tools: LlmTool[];
  calls: { name: string; args: unknown }[];
}

/** A route answering by the script (the last step repeats); `recorded` keeps every tool-call answer with its request. */
export function scriptedRoute(script: readonly ScriptStep[]) {
  const inputs: RouteInput[] = [];
  const recorded: RecordedCall[] = [];
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    inputs.push(input);
    const n = inputs.length;
    const step = script[Math.min(n - 1, script.length - 1)] as ScriptStep;
    const a = typeof step === "function" ? step(input, n) : step;
    if (a instanceof Error) throw a;
    if (Array.isArray(a))
      recorded.push({ messages: [...input.messages], tools: [...(input.tools ?? [])], calls: a });
    return {
      tier: "T1",
      model: "glm-5.3",
      result: Array.isArray(a)
        ? {
            // The ids of fixture lines (build-v2-fixtures.ts fixtureLine): a replay sends the same messages.
            toolCalls: a.map((c, i) => ({
              id: i === 0 ? `call_${input.callType}` : `call_${input.callType}_${i + 1}`,
              name: c.name,
              args: c.args as Record<string, unknown>,
            })),
            finishReason: "tool-calls",
          }
        : { toolCalls: [], text: a, finishReason: "stop" },
      usage: { inputTokens: 2000, cachedTokens: 0, outputTokens: 300 },
      creditsCharged: 0.05,
      creditsMilli: 50,
      routeReason: "default_T1",
      scrubbed: true,
      ruFallback: false,
    } as RouteOutput;
  };
  return { route, inputs, recorded };
}

/** Names of the tools offered on a call. */
export const toolNames = (input: RouteInput): string[] => (input.tools ?? []).map((t) => t.name);

/** The four classes of v3 output (D77 (12)) as owners would describe them. */
export const PROMPTS = {
  site: "Студия ремонта квартир в Казани. Нужен сайт с портфолио и блогом, чтобы клиенты оставляли заявки на замер.",
  booking:
    "Барбершоп на два кресла. Хотим онлайн-запись к мастерам, напоминания клиентам и личный кабинет, где клиент видит свои записи.",
  crm: "Агентство недвижимости: нужна CRM — база клиентов с историей, сделки по этапам и отчёт по сделкам за месяц.",
  shop: "Магазин чая и посуды. Нужен интернет-магазин: каталог товаров с ценами, корзина, оплата онлайн через ЮKassa, доставка СДЭК, учёт остатков на складе и чеки по 54-ФЗ.",
  dental:
    "Стоматологическая клиника в Казани. Хотим, чтобы пациенты записывались к врачам онлайн, а администратор сразу узнавал о новых записях.",
} as const;

/** A question as the model would send it (3 options, the first recommended). */
export function question(
  topic: string,
  text: string,
  options: string[] = ["Первый вариант", "Второй вариант", "Третий вариант"],
): { name: string; args: unknown } {
  return {
    name: "submit_question",
    args: {
      topic,
      text,
      whyItMatters: "От ответа зависит, что войдёт в систему.",
      recommendation: "Подходит для начала, потом можно поменять в брифе.",
      options: options.map((label, i) => ({ id: `o${i + 1}`, label, recommended: i === 0 })),
    },
  };
}

export const update = (args: unknown) => ({ name: "submit_brief_update", args });
export const finish = { name: "finish_interview", args: {} };
export const defer = (topic: string, text: string, assumption: string) => ({
  name: "defer_question",
  args: { topic, text, assumption },
});

/**
 * The dental dialog (the recorded search «стоматология Казань услуги» of V3-05): a search, then the brief from the
 * description and a question about scenarios; data; roles with a deferred content question; the finish.
 */
export const DENTAL_SCRIPT: ScriptStep[] = [
  [{ name: "web_search", args: { query: "стоматология Казань услуги" } }],
  [
    update({
      goals: [
        {
          id: "fill_schedule",
          text: "Пациенты сами записываются к врачу онлайн",
          success: "Записи приходят без звонков",
        },
      ],
      audience: "Пациенты клиники в Казани",
      facts: [
        { text: "Клиники показывают на сайте услуги и цены", url: "https://klinika-kazan.example/uslugi" },
      ],
    }),
    question("scenarios", "Что пациент должен сделать сам, без звонка?", [
      "Выбрать врача и время",
      "Оставить заявку, администратор перезвонит",
      "И то, и другое",
    ]),
  ],
  [
    update({
      scenarios: [
        {
          actor: "client",
          when: "пациент выбирает врача и свободное время",
          // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
          then: ["записывает пациента", "присылает подтверждение"],
          goalId: "fill_schedule",
          moduleHint: "booking",
        },
        {
          actor: "system",
          when: "приходит новая запись",
          // biome-ignore lint/suspicious/noThenProperty: scenario field of the brief (builder-v3.md §3 C1)
          then: ["сообщает администратору"],
          moduleHint: "notify",
        },
      ],
    }),
    question("data", "Какие данные пациента нужны для записи?", [
      "Имя и телефон",
      "Имя, телефон и почта",
      "Только телефон",
    ]),
  ],
  [
    update({
      data: [
        {
          entity: "Записи",
          fields: [{ name: "Имя" }, { name: "Телефон" }, { name: "Услуга" }, { name: "Время" }],
          retention: "пока нужны для работы; удаляем по просьбе пациента",
        },
      ],
    }),
    defer("content", "Какие услуги и цены показать на сайте?", "Покажем список услуг без цен"),
    question("roles", "Кто ещё работает с записями?", ["Администратор", "Администратор и врачи", "Только я"]),
  ],
  [
    update({
      roles: [
        { name: "Владелец", can: ["видит и меняет всё"] },
        { name: "Администратор", can: ["ведёт записи"] },
        { name: "Врач", can: ["видит только свои записи"] },
      ],
    }),
    finish,
  ],
];

/** The owner's answers of the dental dialog: the recommended button, «Решите за меня», an own answer. */
export const DENTAL_ANSWERS: readonly { optionId?: string; delegate?: boolean; text?: string }[] = [
  { optionId: "o1" },
  { delegate: true },
  { text: "Администратор и два врача, врачи видят только свои записи" },
];
