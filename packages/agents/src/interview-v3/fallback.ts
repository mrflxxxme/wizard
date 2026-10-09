// The v3 interview without a model (like planner/fallback.ts, B2-41): when the model's answer does not pass after the
// repairs, the owner still gets the next question of the tree — a deterministic one for the first blocking gap, built
// from the goal vocabulary and the module catalog, whose every option carries its brief patch (the answer is applied
// by code). The same recommended patches fill the gaps on «Дальше решай сам» and at the cap of questions.
import { GOAL_IDS, type GoalId, goalLabel, type SystemBrief } from "@wizard/appspec";
import type { ModuleRegistry } from "@wizard/modules";
import { DEFAULT_REGISTRY } from "../planner/catalog.js";
import { fallbackGoals } from "../planner/fallback.js";
import { clip } from "../planner/tolerant.js";
import { capabilityMap, dataModules, normText } from "./capability.js";
import {
  type BriefPatch,
  DEFAULT_RETENTION,
  type ExtraRequirement,
  type V3QuestionInput,
  type V3Topic,
} from "./schemas.js";

type Scenario = NonNullable<BriefPatch["scenarios"]>[number];

interface GoalTemplate {
  /** Success sign without invented numbers (D49). */
  success: string;
  /** Short button label of the scenario (≤ 80). */
  label: string;
  scenario: Omit<Scenario, "goalId" | "priority">;
}

/** One must scenario per goal of the vocabulary (modules.yaml#goals), with the module that closes it. */
const GOAL_TEMPLATES: Readonly<Record<GoalId, GoalTemplate>> = {
  attract: {
    success: "Посетитель быстро понимает, что вы предлагаете, и знает, как связаться",
    label: "Сайт рассказывает о вас и ведёт к заявке",
    scenario: {
      actor: "visitor",
      when: "посетитель открывает сайт",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["показывает, что вы предлагаете и для кого", "показывает, как связаться или оставить заявку"],
      moduleHint: "landing",
    },
  },
  leads: {
    success: "Заявки с сайта приходят владельцу и не теряются",
    label: "Посетитель оставляет заявку, вы сразу о ней узнаёте",
    scenario: {
      actor: "visitor",
      when: "посетитель оставляет заявку на сайте",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["сохраняет заявку с контактами", "сообщает владельцу о новой заявке"],
      moduleHint: "leads",
    },
  },
  show_offer: {
    success: "Клиент видит услуги и цены без звонка",
    label: "Посетитель смотрит услуги и цены",
    scenario: {
      actor: "visitor",
      when: "посетитель ищет услугу или товар",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["показывает каталог с ценами", "ведёт к заявке"],
      moduleHint: "catalog",
    },
  },
  fill_schedule: {
    success: "Клиенты записываются сами на свободное время",
    label: "Клиент сам записывается на свободное время",
    scenario: {
      actor: "client",
      when: "клиент выбирает услугу и свободное время",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["записывает клиента", "присылает подтверждение и ссылку для отмены"],
      moduleHint: "booking",
    },
  },
  reduce_no_shows: {
    success: "Клиенты получают напоминания и реже не приходят",
    label: "Клиент получает напоминание о визите",
    scenario: {
      actor: "system",
      when: "до визита остаются сутки",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["напоминает клиенту о визите"],
      moduleHint: "notify",
    },
  },
  stay_informed: {
    success: "Владелец и сотрудники сразу узнают о новых заявках и записях",
    label: "Вы сразу узнаёте о новых заявках",
    scenario: {
      actor: "system",
      when: "приходит новая заявка или запись",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["присылает уведомление владельцу"],
      moduleHint: "notify",
    },
  },
  client_history: {
    success: "История каждого клиента под рукой",
    label: "Карточка клиента с историей обращений",
    scenario: {
      actor: "staff",
      when: "сотрудник открывает карточку клиента",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["показывает контакты, заметки и историю обращений"],
      moduleHint: "client_card",
    },
  },
  deal_pipeline: {
    success: "Каждая сделка на своём этапе, ни одна не забыта",
    label: "Сделки по этапам с задачами и напоминаниями",
    scenario: {
      actor: "staff",
      when: "менеджер ведёт сделку",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["показывает сделки по этапам", "напоминает о задачах по сделке"],
      moduleHint: "deals",
    },
  },
  team_work: {
    success: "Каждый сотрудник видит свою работу",
    label: "Сотрудники видят только свои разделы",
    scenario: {
      actor: "owner",
      when: "владелец приглашает сотрудника",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["даёт доступ только к нужным разделам"],
      moduleHint: "staff",
    },
  },
  visibility: {
    success: "Владелец видит результат в цифрах",
    label: "Отчёт по заявкам и записям за период",
    scenario: {
      actor: "owner",
      when: "владелец открывает отчёт",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["показывает заявки, записи и выручку за период"],
      moduleHint: "reports",
    },
  },
  self_service: {
    success: "Клиент сам видит свои записи и заявки",
    label: "Личный кабинет клиента с его записями",
    scenario: {
      actor: "client",
      when: "клиент входит в личный кабинет",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["показывает его записи и заявки", "даёт отменить или перенести запись"],
      moduleHint: "visitor_cabinet",
    },
  },
  retention: {
    success: "Клиенты покупают абонементы и возвращаются",
    label: "Абонементы со списанием визитов",
    scenario: {
      actor: "client",
      when: "клиент покупает абонемент",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["списывает визиты", "напоминает об окончании абонемента"],
      moduleHint: "packages",
    },
  },
  resource_tracking: {
    success: "Понятно, что выдано, кому и до какого числа",
    label: "Учёт выдачи: кому и до какого числа",
    scenario: {
      actor: "staff",
      when: "сотрудник выдаёт вещь",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: ["записывает, кому и до какого числа", "напоминает о возврате"],
      moduleHint: "resources",
    },
  },
  sell_online: {
    success: "Покупатель сам выбирает товар, оформляет заказ и платит на сайте",
    label: "Магазин: корзина, заказ и оплата на сайте",
    scenario: {
      actor: "visitor",
      when: "покупатель выбирает товар на сайте",
      // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
      then: [
        "кладёт товар в корзину",
        "оформляет заказ с доставкой или самовывозом",
        "оплачивает заказ онлайн",
      ],
      moduleHint: "shop",
    },
  },
};

/** What each data-keeping module stores (names only; personal fields marked). */
const DATA_TEMPLATES: Readonly<
  Record<string, { entity: string; fields: { name: string; pii?: boolean }[] }>
> = {
  leads: {
    entity: "Заявки",
    fields: [{ name: "Имя", pii: true }, { name: "Телефон", pii: true }, { name: "Комментарий" }],
  },
  booking: {
    entity: "Записи",
    fields: [
      { name: "Имя", pii: true },
      { name: "Телефон", pii: true },
      { name: "Услуга" },
      { name: "Время" },
    ],
  },
  catalog: {
    entity: "Услуги и цены",
    fields: [{ name: "Название" }, { name: "Цена" }, { name: "Описание" }],
  },
  client_card: {
    entity: "Клиенты",
    fields: [
      { name: "Имя", pii: true },
      { name: "Телефон", pii: true },
      { name: "Почта", pii: true },
      { name: "Заметки" },
    ],
  },
  deals: {
    entity: "Сделки",
    fields: [{ name: "Название" }, { name: "Сумма" }, { name: "Этап" }, { name: "Ответственный" }],
  },
  packages: {
    entity: "Абонементы",
    fields: [{ name: "Клиент", pii: true }, { name: "Осталось визитов" }, { name: "Действует до" }],
  },
  resources: {
    entity: "Выдачи",
    fields: [{ name: "Что выдано" }, { name: "Кому", pii: true }, { name: "Вернуть до" }],
  },
  shop: {
    entity: "Заказы",
    fields: [
      { name: "Покупатель", pii: true },
      { name: "Телефон", pii: true },
      { name: "Товары" },
      { name: "Сумма" },
      { name: "Доставка" },
    ],
  },
  staff: {
    entity: "Сотрудники",
    fields: [{ name: "Имя", pii: true }, { name: "Почта", pii: true }, { name: "Роль" }],
  },
};

const OWNER = { id: "owner", name: "Владелец", can: ["видит и меняет всё"] };
const ADMIN = { id: "admin", name: "Администратор", can: ["ведёт заявки и записи", "видит клиентов"] };
const STAFF = { id: "staff", name: "Сотрудник", can: ["видит свои записи и задачи"] };

const isGoalId = (id: string): id is GoalId => (GOAL_IDS as readonly string[]).includes(id);

/** Vocabulary goals of a brief: its goal ids, else the goals its texts point to (keywords). */
function briefGoalIds(brief: SystemBrief): GoalId[] {
  const out: GoalId[] = [];
  for (const g of brief.goals) {
    const id = isGoalId(g.id) ? g.id : fallbackGoalsStrict(g.text)[0];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** fallbackGoals without its default pair: an empty list when no keyword matches. */
function fallbackGoalsStrict(text: string): GoalId[] {
  const got = fallbackGoals(text);
  const def = fallbackGoals("");
  return got.length === def.length && got.every((g, i) => g === def[i]) && !/сайт|заявк/i.test(text)
    ? []
    : got;
}

export interface FallbackContext {
  brief: SystemBrief;
  prompt: string;
  extras?: readonly ExtraRequirement[];
  registry?: ModuleRegistry;
}

/** A deterministic question with the brief patch of every option. */
export interface FallbackQuestion extends V3QuestionInput {
  patches: Record<string, BriefPatch>;
}

function goalsQuestion(c: FallbackContext): FallbackQuestion {
  const found = fallbackGoalsStrict(c.prompt);
  const ids = [...found];
  for (const g of ["attract", "leads", "show_offer", "fill_schedule"] as const) {
    if (ids.length >= 4) break;
    if (!ids.includes(g)) ids.push(g);
  }
  const patches: Record<string, BriefPatch> = {};
  for (const id of ids)
    patches[id] = { goals: [{ id, text: goalLabel(id), success: GOAL_TEMPLATES[id].success }] };
  return {
    topic: "goals",
    text: "Что система должна дать бизнесу в первую очередь?",
    whyItMatters: "От цели зависит, какие разделы и сценарии войдут в систему.",
    recommendation:
      found.length > 0
        ? "Это следует из вашего описания. Другие цели можно добавить в брифе."
        : "Подходит для начала, потом можно поменять в брифе.",
    options: ids.map((id, i) => ({ id, label: clip(goalLabel(id), 80), recommended: i === 0 })),
    allowDelegate: true,
    patches,
  };
}

function scenariosQuestion(c: FallbackContext): FallbackQuestion {
  const own = briefGoalIds(c.brief);
  const ids = own.slice(0, 3);
  for (const g of [...fallbackGoalsStrict(c.prompt), "leads", "attract", "stay_informed"] as GoalId[]) {
    if (ids.length >= 3) break;
    if (!ids.includes(g)) ids.push(g);
  }
  const goalOf = (g: GoalId) =>
    c.brief.goals.find((x) => x.id === g || briefGoalIds({ ...c.brief, goals: [x] })[0] === g)?.id;
  const scenario = (g: GoalId): Scenario => {
    const goalId = goalOf(g);
    return { ...GOAL_TEMPLATES[g].scenario, ...(goalId ? { goalId } : {}), priority: "must" };
  };
  const patches: Record<string, BriefPatch> = {};
  const options: V3QuestionInput["options"] = ids.map((g, i) => {
    patches[g] = { scenarios: [scenario(g)] };
    return { id: g, label: GOAL_TEMPLATES[g].label, recommended: i === 0 };
  });
  const mine = ids.filter((g) => own.includes(g));
  if (mine.length >= 2) {
    patches.all = { scenarios: mine.map(scenario) };
    options.push({ id: "all", label: "Всё, что связано с вашими целями", recommended: false });
  }
  return {
    topic: "scenarios",
    text: "Что обязательно должно работать с первого дня?",
    whyItMatters: "Обязательные сценарии сборка проверит в браузере перед публикацией.",
    recommendation: "Это главный сценарий вашей первой цели. Остальное можно добавить в брифе.",
    options,
    allowDelegate: true,
    patches,
  };
}

function dataQuestion(c: FallbackContext): FallbackQuestion {
  const registry = c.registry ?? DEFAULT_REGISTRY;
  const verdicts = capabilityMap(c.brief, c.extras ?? [], registry).verdicts;
  const mods = dataModules(verdicts, registry).filter((m) => DATA_TEMPLATES[m]);
  const needed = (mods.length ? mods : ["leads"])
    .map((m) => DATA_TEMPLATES[m])
    .filter((t) => t !== undefined);
  const withRetention = (t: { entity: string; fields: { name: string; pii?: boolean }[] }) => ({
    ...t,
    retention: DEFAULT_RETENTION,
  });
  const notes = DATA_TEMPLATES.client_card;
  const withNotes = needed.some((t) => t.entity === notes?.entity) || !notes ? needed : [...needed, notes];
  return {
    topic: "data",
    text: "Какие данные система будет хранить?",
    whyItMatters: "От этого зависят поля форм, кто что видит и как долго хранятся персональные данные.",
    recommendation:
      "Только то, что нужно для работы выбранных разделов: меньше персональных данных — меньше рисков.",
    options: [
      {
        id: "needed",
        label: clip(`Только нужное: ${needed.map((t) => t.entity).join(", ")}`, 80),
        recommended: true,
      },
      { id: "with_notes", label: "Нужное и заметки о клиентах", recommended: false },
      { id: "contacts_only", label: "Только имя и телефон обратившихся", recommended: false },
    ],
    allowDelegate: true,
    patches: {
      needed: { data: needed.map(withRetention) },
      with_notes: { data: withNotes.map(withRetention) },
      contacts_only: {
        data: [
          withRetention({
            entity: "Обращения",
            fields: [
              { name: "Имя", pii: true },
              { name: "Телефон", pii: true },
            ],
          }),
        ],
      },
    },
  };
}

function rolesQuestion(c: FallbackContext): FallbackQuestion {
  const t = normText(`${c.prompt} ${c.brief.audience}`);
  const admin = /администратор/.test(t);
  const staff = /мастер|врач|тренер|сотрудник|менеджер|преподавател|команд/.test(t);
  const rec = admin && staff ? "all" : admin ? "with_admin" : staff ? "with_staff" : "only_me";
  const options = [
    { id: "only_me", label: "Только я" },
    { id: "with_admin", label: "Я и администратор" },
    { id: "with_staff", label: "Я и сотрудники, каждый видит своё" },
    { id: "all", label: "Я, администратор и сотрудники" },
  ];
  return {
    topic: "roles",
    text: "Кто, кроме вас, будет работать в системе?",
    whyItMatters: "От этого зависит, кто что видит и меняет.",
    recommendation:
      rec === "only_me"
        ? "Для начала хватит вас одного. Добавить людей и поменять доступы можно потом."
        : "Так следует из вашего описания. Доступы можно поменять потом.",
    options: options.map((o) => ({ ...o, recommended: o.id === rec })),
    allowDelegate: true,
    patches: {
      only_me: { roles: [OWNER] },
      with_admin: { roles: [OWNER, ADMIN] },
      with_staff: { roles: [OWNER, STAFF] },
      all: { roles: [OWNER, ADMIN, STAFF] },
    },
  };
}

/** The deterministic question of a blocking topic (goals, scenarios, data, roles); null for the other topics. */
export function fallbackQuestion(topic: V3Topic, c: FallbackContext): FallbackQuestion | null {
  switch (topic) {
    case "goals":
      return goalsQuestion(c);
    case "scenarios":
      return scenariosQuestion(c);
    case "data":
      return dataQuestion(c);
    case "roles":
      return rolesQuestion(c);
    default:
      return null;
  }
}

/** The recommended answer of a blocking topic as a patch and its label (what «решили за вас» writes). */
export function defaultPatch(
  topic: V3Topic,
  c: FallbackContext,
): { patch: BriefPatch; label: string } | null {
  const q = fallbackQuestion(topic, c);
  const rec = q?.options.find((o) => o.recommended);
  const patch = rec ? q?.patches[rec.id] : undefined;
  return rec && patch ? { patch, label: rec.label } : null;
}
