// Fallback of the goal interview without a model (B2-41): when the model's submit_goals or submit_plan still fails after
// the tolerant reading and the repairs, the client never meets «Попробуйте ещё раз» — the interview goes on with
// deterministic questions from the brief and the catalog (goals vocabulary by keywords, a recommendation by niche via
// themeForNiche), and the plan is put together from the interview goals and candidate modules. Both are plain code.
import {
  evalCondition,
  GOAL_IDS,
  type GoalId,
  goalLabel,
  type ModuleManifest,
  type PlanError,
  resolveParams,
  type SystemPlan,
} from "@wizard/appspec";
import { type CompileResult, compilePlan, type ModuleRegistry } from "@wizard/modules";
import { scrubJson } from "@wizard/pii";
import { themeForNiche } from "@wizard/ui-kit/themes";
import { availableModules, defaultDesign, readySections } from "./catalog.js";
import { editPlan, type PlanEdit } from "./edits.js";
import { planErrors } from "./planner.js";
import type { GoalAnswer, GoalQuestion, GoalsAnalysis } from "./schemas.js";
import { clip } from "./tolerant.js";

/** Keyword stems of the goals vocabulary (lower-cased Russian brief); order — the tie order. */
const GOAL_STEMS: Readonly<Record<GoalId, readonly string[]>> = {
  leads: ["заявк", "обращени", "перезвон", "обратн", "лид"],
  fill_schedule: ["запис", "бронир", "бронь", "расписан", "слот", "сеанс", "приём", "прием"],
  attract: ["сайт", "лендинг", "страниц", "визитк", "привлеч", "рассказ"],
  show_offer: ["прайс", "цены", "цен ", "каталог", "меню", "ассортимент", "витрин"],
  reduce_no_shows: ["неявк", "напомин", "не приход", "не доход"],
  stay_informed: ["уведом", "оповещ", "сразу узна", "в курсе", "телеграм", "telegram"],
  client_history: ["истори", "база клиент", "базу клиент", "клиентск", "crm", "срм"],
  deal_pipeline: ["сделк", "воронк", "смет", "коммерческ", "продаж"],
  team_work: ["сотрудник", "мастер", "менеджер", "распредел", "команд"],
  visibility: ["отчёт", "отчет", "статистик", "аналитик", "выручк", "в цифрах"],
  self_service: ["личный кабинет", "личном кабинете", "кабинет клиента", "свои записи", "свои заявки"],
  retention: ["абонемент", "пакет", "подписк", "лояльн", "повторн"],
  resource_tracking: ["выдач", "прокат", "аренд", "инвентар", "инструмент", "оборудован", "склад"],
};

/** Niche by keywords (2–5 words, modules.yaml#ai_rules); the first match wins. */
const NICHES: readonly (readonly [RegExp, string])[] = [
  [/стоматолог|зубн/, "стоматологическая клиника"],
  [/ветеринар|груминг|зоосалон/, "услуги для животных"],
  [/клиник|медицин|врач/, "медицинская клиника"],
  [/барбер/, "барбершоп"],
  [/маникюр|педикюр|ногт/, "студия маникюра"],
  [/салон|парикмах|красот|косметолог|брови|ресниц/, "салон красоты"],
  [/йог/, "студия йоги"],
  [/фитнес|тренаж|трениров/, "фитнес-студия"],
  [/танц|хореограф/, "танцевальная студия"],
  [/психолог|психотерап/, "психологическая практика"],
  [/репетитор|курс|школ|обучен|урок/, "обучение и курсы"],
  [/юрист|юридич|адвокат|нотари/, "юридические услуги"],
  [/бухгалт/, "бухгалтерские услуги"],
  [/автосервис|шиномонтаж|автомойк/, "автосервис"],
  [/ремонт|отделк/, "ремонт и отделка"],
  [/кафе|ресторан|кофейн|бар\b/, "кафе"],
  [/пекарн|кондитер|торт/, "кондитерская"],
  [/фотограф|фотостуди/, "фотостудия"],
  [/переговорн|коворкинг/, "коворкинг"],
  [/библиотек/, "библиотека"],
  [/прокат|аренд/, "прокат"],
  [/мастерск/, "мастерская"],
  [/клининг|уборк/, "клининг"],
  [/гостиниц|отел|хостел|гостев/, "гостиница"],
  [/недвижим|риелтор|риэлтор/, "агентство недвижимости"],
  [/магазин|товар/, "магазин"],
];

const ROLES: readonly (readonly [RegExp, string])[] = [
  [/администратор/, "Администратор"],
  [/врач/, "Врач"],
  [/мастер/, "Мастер"],
  [/тренер/, "Тренер"],
  [/менеджер/, "Менеджер"],
  [/преподавател|педагог/, "Преподаватель"],
];

const lower = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Niche of the brief: by keywords, else the first words of its first sentence, else «малый бизнес». */
export function fallbackNiche(brief: string): string {
  const t = lower(brief);
  const hit = NICHES.find(([re]) => re.test(t));
  if (hit) return hit[1];
  const words = (brief.split(/[.!?\n]/)[0] ?? "")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .toLowerCase();
  return words.length >= 2 ? clip(words, 80) : "малый бизнес";
}

/** 1–3 goals of the brief by keywords (most stems first, then the earliest mention); none → attract and leads. */
export function fallbackGoals(brief: string): GoalId[] {
  const t = ` ${lower(brief)} `;
  const scored = GOAL_IDS.map((id) => {
    const stems = GOAL_STEMS[id].map(lower);
    const at = stems.map((s) => t.indexOf(s)).filter((i) => i >= 0);
    return { id, n: at.length, first: at.length ? Math.min(...at) : Number.POSITIVE_INFINITY };
  })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.first - b.first);
  const ids = scored.slice(0, 3).map((x) => x.id);
  return ids.length ? ids : ["attract", "leads"];
}

/** The client's sentence about a goal (≤ 200, PII scrubbed later), else the vocabulary label. */
function statement(brief: string, goal: GoalId): string {
  const stems = GOAL_STEMS[goal].map(lower);
  const sentence = brief
    .split(/(?<=[.!?])\s+|\n/)
    .map((x) => x.trim())
    .find((x) => stems.some((s) => lower(` ${x} `).includes(s)));
  return sentence && sentence.length >= 3 && sentence.length <= 200 ? sentence : goalLabel(goal);
}

const manifestsOf = (registry: ModuleRegistry): ModuleManifest[] => registry.modules.map((d) => d.manifest);

/** Available modules that close the goals, in the order of the goals (the candidates of the interview sketch). */
function candidates(goals: readonly string[], registry: ModuleRegistry): ModuleManifest[] {
  const ok = availableModules(registry);
  const out: ModuleManifest[] = [];
  for (const g of goals)
    for (const m of manifestsOf(registry))
      if (ok.has(m.id) && (m.goals as readonly string[]).includes(g) && !out.includes(m)) out.push(m);
  return out;
}

interface ParamQuestion {
  module: string;
  param: string;
  text: string;
  why: string;
  options: { id: string; label: string; value: unknown }[];
  /** Recommended option id for the brief (niche theme and keywords). */
  recommend: (brief: string) => string;
}

/** Parameter questions the fallback may ask, most useful first; options map to manifest values. */
const PARAM_QUESTIONS: readonly ParamQuestion[] = [
  {
    module: "leads",
    param: "contact",
    text: "Какой контакт клиента обязателен в заявке?",
    why: "По нему вы свяжетесь с клиентом после заявки",
    options: [
      { id: "phone", label: "Телефон", value: "phone" },
      { id: "email", label: "Почта", value: "email" },
      { id: "any", label: "Телефон или почта", value: "any" },
    ],
    recommend: (brief) => {
      const t = lower(brief);
      if (/почт|email|e-mail/.test(t) && !/звон|телефон/.test(t)) return "email";
      const theme = themeForNiche(fallbackNiche(brief));
      return /звон|телефон/.test(t) || ["care", "warm", "bright", "bistro", "workshop"].includes(theme)
        ? "phone"
        : "any";
    },
  },
  {
    module: "booking",
    param: "confirm",
    text: "Как подтверждать запись клиента?",
    why: "Сразу — меньше работы; сотрудником — больше контроля над расписанием",
    options: [
      { id: "auto", label: "Сразу, без звонка", value: "auto" },
      { id: "manual", label: "Сотрудник подтверждает", value: "manual" },
    ],
    recommend: (brief) => (/подтвержд|перезвон/.test(lower(brief)) ? "manual" : "auto"),
  },
  {
    module: "notify",
    param: "channels",
    text: "Куда присылать уведомления о новых заявках и записях?",
    why: "Так вы и сотрудники сразу узнаете о новом клиенте",
    options: [
      { id: "email", label: "На почту", value: ["email"] },
      { id: "telegram", label: "В Telegram", value: ["telegram"] },
      { id: "both", label: "На почту и в Telegram", value: ["email", "telegram"] },
    ],
    recommend: (brief) => (/телеграм|telegram/.test(lower(brief)) ? "both" : "email"),
  },
  {
    module: "packages",
    param: "kind",
    text: "Что вы продаёте клиентам?",
    why: "От этого зависит, как считается остаток абонемента",
    options: [
      { id: "visits", label: "Число визитов", value: "visits" },
      { id: "period", label: "Доступ на срок", value: "period" },
      { id: "both", label: "Визиты на срок", value: "both" },
    ],
    recommend: () => "both",
  },
];

const ROLE_OPTIONS = { solo: "Только я", admin: "Я и администратор", team: "Несколько сотрудников" } as const;

/**
 * Deterministic goals analysis of a brief (no model): niche, 1–3 goals, roles, candidate modules and 2–3 button
 * questions with one recommended option each — the main goal, who works in the system, one parameter of a module.
 */
export function fallbackAnalysis(brief: string, registry: ModuleRegistry): GoalsAnalysis {
  const t = lower(brief);
  const goals = fallbackGoals(brief);
  const mods = candidates(goals, registry);
  const roles = ROLES.filter(([re]) => re.test(t)).map(([, r]) => r);
  const questions: GoalQuestion[] = [];

  const extra = (["leads", "attract", "fill_schedule", "show_offer"] as const).filter(
    (g) => !goals.includes(g),
  );
  const goalOptions = [...goals, ...extra].slice(0, Math.max(2, Math.min(4, goals.length + 1)));
  questions.push({
    id: "q1",
    topic: "goals",
    text: "Что сейчас важнее всего для вашего дела?",
    whyItMatters: "С этого начнётся система и это будет на первом экране",
    options: goalOptions.map((g, i) => ({ id: g, label: clip(goalLabel(g), 60), recommended: i === 0 })),
    allowCustom: true,
  });

  if (availableModules(registry).has("staff")) {
    const rec = /сотрудник|мастера|врачи|тренеры|менеджеры|команд/.test(t)
      ? "team"
      : /администратор/.test(t)
        ? "admin"
        : "solo";
    questions.push({
      id: "q2",
      topic: "roles",
      text: "Кто, кроме вас, будет работать в системе?",
      whyItMatters: "От этого зависит, кому нужен вход и какие разделы им видны",
      options: (Object.keys(ROLE_OPTIONS) as (keyof typeof ROLE_OPTIONS)[]).map((id) => ({
        id,
        label: ROLE_OPTIONS[id],
        recommended: id === rec,
      })),
      allowCustom: true,
    });
  }

  const ids = new Set(mods.map((m) => m.id));
  const pq = PARAM_QUESTIONS.find((q) => ids.has(q.module));
  const manifest = pq && manifestsOf(registry).find((m) => m.id === pq.module);
  if (pq && manifest?.params.some((p) => p.name === pq.param)) {
    const rec = pq.recommend(brief);
    questions.push({
      id: `q${questions.length + 1}`,
      topic: "params",
      module: pq.module,
      param: pq.param,
      text: pq.text,
      whyItMatters: pq.why,
      options: pq.options.map((o) => ({ id: o.id, label: o.label, recommended: o.id === rec })),
      allowCustom: false,
    });
  }

  return {
    niche: fallbackNiche(brief),
    goals: goals.map((id) => ({ id, statement: statement(brief, id) })),
    roles,
    resources: [],
    modules: mods.slice(0, 12).map((m) => ({ id: m.id, why: clip(`Закрывает цель: ${m.name}`, 160) })),
    outOfScope: [],
    questions,
  };
}

export interface FallbackPlanInput {
  analysis: GoalsAnalysis | null;
  questions: readonly GoalQuestion[];
  answers: readonly GoalAnswer[];
}

export type FallbackPlanResult = { plan: SystemPlan; compiled: CompileResult & { ok: true } } | null;

/** Value of a parameter answer: the fallback question's mapping, else the option id when the manifest allows it. */
function paramValue(q: GoalQuestion, a: GoalAnswer, registry: ModuleRegistry): unknown {
  if (!a.optionId || !q.module || !q.param) return undefined;
  const known = PARAM_QUESTIONS.find((x) => x.module === q.module && x.param === q.param);
  const mapped = known?.options.find((o) => o.id === a.optionId);
  if (mapped) return mapped.value;
  const spec = manifestsOf(registry)
    .find((m) => m.id === q.module)
    ?.params.find((p) => p.name === q.param);
  if (!spec || !("options" in spec) || !spec.options) return undefined;
  if (!spec.options.some((o) => o.value === a.optionId)) return undefined;
  return spec.type === "enum_list" ? [a.optionId] : a.optionId;
}

/**
 * A plan from the interview without a model: its goals (the main goal of the answers first), the available candidate
 * modules with the answered parameters and their required links, a landing with header, hero, the form or booking
 * section and footer, what the analysis left out of scope. Validated and compiled; null when it does not compile.
 */
export function fallbackPlan(
  input: FallbackPlanInput,
  registry: ModuleRegistry,
  opts: { appName?: string } = {},
): FallbackPlanResult {
  const a = input.analysis;
  if (!a) return null;
  const answerOf = (q: GoalQuestion) => input.answers.find((x) => x.questionId === q.id);

  // Goals: the analysis, the main goal the client picked first.
  let goals = a.goals.map((g) => ({ ...g }));
  for (const q of input.questions) {
    const id = answerOf(q)?.optionId;
    if (q.topic !== "goals" || !id || !(GOAL_IDS as readonly string[]).includes(id)) continue;
    goals = [
      goals.find((g) => g.id === id) ?? { id: id as GoalId, statement: goalLabel(id) },
      ...goals.filter((g) => g.id !== id),
    ];
  }
  goals = goals.slice(0, 3);

  // Modules: the analysis candidates that compile today, plus those that close a goal none of them closes (the main
  // goal the client picked may be new); the site always.
  const ok = availableModules(registry);
  const named = a.modules.map((m) => m.id).filter((id) => ok.has(id));
  const namedGoals = new Set<string>(
    manifestsOf(registry)
      .filter((m) => named.includes(m.id))
      .flatMap((m) => m.goals),
  );
  const open = goals.map((g) => g.id).filter((g) => !namedGoals.has(g));
  const ids = [...named, ...candidates(open, registry).map((m) => m.id)];
  const params = new Map<string, Record<string, unknown>>();
  for (const q of input.questions) {
    const ans = answerOf(q);
    if (q.topic !== "params" || !ans || !q.module || !q.param) continue;
    const v = paramValue(q, ans, registry);
    if (v !== undefined) params.set(q.module, { ...(params.get(q.module) ?? {}), [q.param]: v });
  }
  const team = input.questions.some((q) => q.topic === "roles" && answerOf(q)?.optionId === "team");
  const order = [
    ...(ok.has("landing") ? ["landing"] : []),
    ...ids,
    ...(team && ok.has("staff") ? ["staff"] : []),
    ...[...params.keys()],
  ].filter((id, i, xs) => xs.indexOf(id) === i && ok.has(id));
  if (order.length === 0) return null;

  const soon = a.modules.filter((m) => !ok.has(m.id));
  let plan: SystemPlan = {
    version: 1,
    niche: a.niche,
    goals,
    modules: [],
    design: defaultDesign(registry),
    outOfScope: [
      ...a.outOfScope.map((o) => ({
        request: o.request,
        replacement: "Пока нет — можно обсудить после запуска",
        category: o.category,
      })),
      ...soon.map((m) => ({
        request: clip(manifestsOf(registry).find((x) => x.id === m.id)?.name ?? m.why, 300),
        replacement: "Пока нет: модуль ещё в разработке",
        category: "other" as const,
      })),
    ].slice(0, 20),
    custom: [],
  };
  for (const id of order) {
    if (plan.modules.some((m) => m.id === id)) {
      const p = params.get(id);
      if (p) {
        const r = editPlan(
          plan,
          Object.entries(p).map(
            ([param, value]) => ({ op: "set_param", module: id, param, value }) as PlanEdit,
          ),
          registry,
        );
        if (r.ok) plan = r.plan;
      }
      continue;
    }
    const p = params.get(id);
    const r = editPlan(plan, [{ op: "add_module", module: id, ...(p ? { params: p } : {}) }], registry);
    if (r.ok) plan = r.plan;
  }

  // Parameters a module expects of its links (booking needs catalog.with_duration = true): a link added before the
  // module that needs it keeps its defaults otherwise.
  const present = new Set(plan.modules.map((m) => m.id));
  for (const pm of [...plan.modules]) {
    const m = manifestsOf(registry).find((x) => x.id === pm.id);
    for (const r of m?.requires ?? []) {
      if (!r.expectParams || !present.has(r.module) || !m) continue;
      if (!evalCondition(r.when, resolveParams(m, pm.params ?? {}), present)) continue;
      const edits = Object.entries(r.expectParams).map(
        ([param, value]) => ({ op: "set_param", module: r.module, param, value }) as PlanEdit,
      );
      const e = editPlan(plan, edits, registry);
      if (e.ok) plan = e.plan;
    }
  }

  // Landing: header first, the section of the main module, footer last (ready sections only).
  if (plan.landing) {
    const ready = new Set(readySections(registry).map((s) => s.type));
    const edits: PlanEdit[] = [];
    if (ready.has("header")) edits.push({ op: "add_section", type: "header", at: 0 });
    for (const [type, mod] of [
      ["services", "catalog"],
      ["booking", "booking"],
      ["lead_form", "leads"],
    ] as const)
      if (ready.has(type) && present.has(mod)) edits.push({ op: "add_section", type });
    if (ready.has("footer")) edits.push({ op: "add_section", type: "footer" });
    const r = editPlan(plan, edits, registry);
    if (r.ok) plan = r.plan;
  }

  // Every goal of the plan is closed by a module of the plan (manifest goals, like validateSystemPlan).
  const closedBy = new Set<string>(
    plan.modules.flatMap((pm) => manifestsOf(registry).find((m) => m.id === pm.id)?.goals ?? []),
  );
  let kept = plan.goals.filter((g) => closedBy.has(g.id));
  if (kept.length === 0) {
    const first = manifestsOf(registry).find((m) => m.id === plan.modules[0]?.id)?.goals[0];
    if (!first) return null;
    kept = [{ id: first, statement: goalLabel(first) }];
  }
  if (kept.length !== plan.goals.length) {
    const r = editPlan(plan, [{ op: "set_goals", goals: kept }], registry);
    if (!r.ok) return null;
    plan = r.plan;
  }

  const clean = scrubJson(plan).value;
  const errors: PlanError[] = planErrors(clean, registry);
  if (errors.length) return null;
  const compiled = compilePlan(clean, registry, opts);
  return compiled.ok ? { plan: compiled.plan, compiled } : null;
}
