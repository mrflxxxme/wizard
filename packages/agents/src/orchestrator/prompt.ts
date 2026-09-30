// Orchestrator prompt: orchestrator.yaml#prompt_skeleton. Static part is one system message (cacheable prefix),
// dynamic part is the user message.
import type { LlmMessage } from "@wizard/llm";
import type { Analysis, Answer, Question } from "./schemas.js";
import { FORKS, type ForkContext, forkOptions, getFork, type Plan } from "./taxonomy.js";

const ROLE =
  "Ты — оркестратор Wizard: превращаешь описание задачи нетехнического владельца бизнеса в карточку системы. Кратко, по-русски, без жаргона (не «сущность», а «данные»; не «RLS», а «кто что видит»).";

const PLATFORM =
  "Что умеет платформа: данные, права, статусы и автоматизации описываются спекой; экраны React на библиотеке ядра; подключения ЮKassa, Telegram, почта, QR; вход по коду на почту или через Telegram (по телефону — только на тарифах Старт и Бизнес); PWA; 152-ФЗ встроен. Скелет: Каталог → Заявка → Процесс → Оплата → Выдача.";

const NON_GOALS = [
  "визуальный редактор перетаскиванием и совместное редактирование",
  "выгрузка и правка кода пользователем",
  "свои домены (только поддомены платформы)",
  "нативные мобильные приложения (только PWA)",
  "чат-виджеты, чат-боты и поиск по документам внутри систем",
  "amoCRM и другие CRM",
  "госсектор напрямую (реестр ПО, ЕСИА)",
];

const DEFAULTS = [
  "Роль-администратор всегда есть; это владелец системы",
  "Вход для ролей со входом — по коду на почту и через Telegram (для Telegram нужен свой бот). Вход по телефону (SMS) — только на тарифах start и business",
  "Уведомления — email; Telegram только если упомянут",
  "Согласие на обработку ПДн и страница политики — всегда при наличии ПДн",
  "Срок хранения ПДн: мероприятия — 30 дней после даты события; заказы — 3 года; контакты без заказов и прочее — 1 год",
  "Внешний вид — стиль по умолчанию, пользователь меняет его в «Стиле» бесплатно",
  "Адаптивность и PWA — всегда",
  "Пользователь видит только свои записи, персонал — все",
  "Выгрузка CSV для таблиц персонала — всегда",
  "Оплата не подключается, если про деньги в брифе ничего нет",
];

const OUTPUT_RULES = [
  "Отвечай только вызовом инструмента.",
  "У каждого вопроса 2–4 варианта и ровно один recommended.",
  "whyItMatters — про последствия для бизнеса.",
  "Варианты — только из таксономии: можно переименовать для понятности и убрать неприменимые, новые смыслы не добавлять.",
  "Не выдумывай реальные данные (каталоги, цены, имена); примеры помечай словом «пример».",
  "Не повторяй персональные данные из брифа; плейсхолдеры вида [ФИО_1] не переносить в ответ.",
];

const ACCEPTANCE_RULES =
  "Критерии приёмки проверяемы машиной: права (роль × данные × действие) или сценарий с наблюдаемым результатом. Плохо: «удобный интерфейс». Хорошо: «Участник не видит чужие заявки». Id — AC1..ACn по порядку; на каждую роль со входом — хотя бы один критерий (check.role).";

const EXAMPLE = [
  "Бриф (синтетический): «Мастерская делает торты на заказ, клиенты выбирают начинку и дату, предоплата 50%».",
  'Analysis: {segment: "made_to_order", skeleton: [catalog, application, payment, fulfillment], roles: [{name: "owner", isStaff: true}, {name: "client", access: "login"}], unknowns: ["F-GD-CAPACITY"]}.',
  "Вопросы: F-GD-CATALOG «Как устроен товар?», F-GD-CAPACITY «Сколько заказов в день вы успеваете?», F-GD-DELIVERY «Как клиент получает заказ?».",
  "Фрагмент карточки: acceptance [{id: AC1, text: «Клиент не видит чужие заказы», check: {type: permission, role: client, entity: order, op: read, expect: deny}}].",
].join("\n");

function taxonomyDigest(): string {
  return FORKS.map(
    (f) => `${f.id} (${f.group}, impact ${f.impact}): ${f.q} [${f.options.join(" | ")}] — ${f.rec}`,
  ).join("\n");
}

let staticCache: string | null = null;

/** prompt_skeleton.static, fixed order. */
export function staticPrompt(): string {
  staticCache ??= [
    `# Роль\n${ROLE}`,
    `# Платформа\n${PLATFORM}`,
    `# Пока не умеем (честно отвечать «пока не умеем»)\n${NON_GOALS.map((x) => `- ${x}`).join("\n")}`,
    `# Развилки (id, суть, варианты, правило рекомендации)\n${taxonomyDigest()}`,
    `# Умолчания (об этом не спрашивать)\n${DEFAULTS.map((x) => `- ${x}`).join("\n")}`,
    `# Правила ответа\n${OUTPUT_RULES.map((x) => `- ${x}`).join("\n")}`,
    `# Критерии приёмки\n${ACCEPTANCE_RULES}`,
    `# Пример\n${EXAMPLE}`,
  ].join("\n\n");
  return staticCache;
}

export interface OrgContext {
  plan: Plan;
  ruOnly?: boolean;
  /** Names of the org's existing systems. */
  systems?: string[];
}

function orgSection(org: OrgContext): string {
  const systems = org.systems && org.systems.length > 0 ? org.systems.join(", ") : "нет";
  return `# Организация\nТариф: ${org.plan}. Только РФ: ${org.ruOnly ? "да" : "нет"}. Существующие системы: ${systems}.`;
}

export interface DynamicInput {
  org: OrgContext;
  brief: string;
  currentSpec?: string;
  analysis?: Analysis;
  forkList?: { forkId: string }[];
  questions?: Question[];
  answers?: Answer[];
  defaults?: { forkId: string; optionId: string }[];
  previousCard?: object;
  edits?: string[];
  task: string;
}

export function answersText(questions: readonly Question[], answers: readonly Answer[]): string {
  return answers
    .map((a) => {
      if (a.text !== undefined) return `${a.questionId} (${a.forkId}) — свой вариант: «${a.text}»`;
      const q = questions.find((x) => x.id === a.questionId);
      const label = q?.options.find((o) => o.id === a.optionId)?.label;
      return `${a.questionId} (${a.forkId}) = ${a.optionId}${label ? ` «${label}»` : ""}${a.byRecommendation ? " (по рекомендации)" : ""}`;
    })
    .join("\n");
}

function forkLines(forks: readonly { forkId: string }[], ctx: ForkContext): string {
  return forks
    .map(({ forkId }) => {
      const f = getFork(forkId);
      return `- ${forkId}: ${f?.q ?? ""} Варианты: ${forkOptions(forkId, ctx).join(", ")}. Рекомендация: ${f?.rec ?? ""}`;
    })
    .join("\n");
}

/** prompt_skeleton.dynamic: org_context, current_spec, brief, answers (+ step data and the task). */
export function buildMessages(input: DynamicInput): LlmMessage[] {
  const parts = [orgSection(input.org)];
  if (input.currentSpec) parts.push(`# Текущая система\n${input.currentSpec}`);
  parts.push(`# Описание задачи\n${input.brief}`);
  if (input.analysis) parts.push(`# Анализ\n${JSON.stringify(input.analysis)}`);
  if (input.forkList)
    parts.push(`# Развилки для вопросов\n${forkLines(input.forkList, { plan: input.org.plan })}`);
  if (input.questions && input.answers && input.answers.length > 0) {
    parts.push(`# Ответы пользователя\n${answersText(input.questions, input.answers)}`);
  }
  if (input.defaults && input.defaults.length > 0) {
    parts.push(
      `# Решено по умолчанию (внести в assumptions)\n${input.defaults.map((d) => `- ${d.forkId} = ${d.optionId}`).join("\n")}`,
    );
  }
  if (input.previousCard) parts.push(`# Текущая карточка\n${JSON.stringify(input.previousCard)}`);
  if (input.edits && input.edits.length > 0) {
    parts.push(`# Пожелания к карточке\n${input.edits.map((e, i) => `${i + 1}. ${e}`).join("\n")}`);
  }
  parts.push(`# Задача\n${input.task}`);
  return [
    { role: "system", content: staticPrompt() },
    { role: "user", content: parts.join("\n\n") },
  ];
}
