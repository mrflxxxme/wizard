// Generates the recorded feeds of the mock API (test/fixtures/feeds/<name>.json):
// «форум» from the golden LLM fixture tools/fixtures/demo/forum.jsonl, «кондитерская» from specs/appspec/examples/bakery.json.
// Event payloads follow specs/platform/workflows.yaml#events.types. Run: node apps/platform-web/test/fixtures/gen-feeds.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../../..");
const OUT = join(import.meta.dirname, "feeds");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const OP_LABELS = {
  set_app: "описание системы",
  set_theme: "оформление",
  add_role: ["роль", "роли", "ролей"],
  add_entity: ["вид данных", "вида данных", "видов данных"],
  set_permission: ["правило доступа", "правила доступа", "правил доступа"],
  add_workflow: ["автоматизация", "автоматизации", "автоматизаций"],
  add_integration: ["подключение", "подключения", "подключений"],
  add_function: ["функция", "функции", "функций"],
  add_page: ["экран", "экрана", "экранов"],
  set_acceptance: "критерии приёмки",
  set_compliance: "страница политики",
};
const plural = (n, [one, few, many]) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const TARGET_OPS = {
  roles: ["set_app", "set_theme", "add_role"],
  entities: ["add_entity"],
  permissions: ["set_permission"],
  workflows: ["add_workflow"],
  integrations: ["add_integration"],
  functions: ["add_function"],
  pages: ["add_page"],
  acceptance: ["set_acceptance"],
  compliance: ["set_compliance"],
};

function opsSummary(ops) {
  const counts = new Map();
  for (const o of ops) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  return [...counts].map(([op, n]) => {
    const label = OP_LABELS[op] ?? op;
    return Array.isArray(label) ? `Спека: +${n} ${plural(n, label)}` : `Спека: ${label}`;
  });
}

function gateReports(acceptance, { g0 = 14, g2Warn = true } = {}) {
  const at = "2026-09-30T10:00:00.000Z";
  const g0Checks = Array.from({ length: g0 }, (_, i) => ({
    id: `G0-${String(i + 1).padStart(2, "0")}`,
    status: "pass",
    severity: "blocker",
    message_ru: `Статическая проверка ${i + 1} пройдена`,
  }));
  const g1Checks = acceptance.map((ac) => {
    const later = ac.check?.milestone && ac.check.milestone !== "M0";
    return {
      id: `G1-${ac.id}`,
      acId: ac.id,
      status: later ? "skip" : "pass",
      severity: "blocker",
      message_ru: later ? `${ac.text}: проверка появится позже` : ac.text,
    };
  });
  const g2Checks = [
    { id: "G2-A11Y-01", status: "pass", severity: "warning", message_ru: "Подписи у всех полей формы" },
    {
      id: "G2-PERF-01",
      status: "pass",
      severity: "warning",
      message_ru: "Главная загружается быстрее 2 секунд",
    },
    g2Warn
      ? {
          id: "G2-A11Y-02",
          status: "warn",
          severity: "warning",
          message_ru: "Мелкий текст в подвале плохо читается на телефоне",
          file: "ui/Landing.tsx",
          line: 42,
        }
      : { id: "G2-A11Y-02", status: "pass", severity: "warning", message_ru: "Контраст текста достаточный" },
  ];
  const summary = (checks) => {
    const s = { pass: 0, fail: 0, warn: 0, skip: 0, error: 0 };
    for (const c of checks) s[c.status]++;
    return s;
  };
  return [
    ["G0", g0Checks, 2100],
    ["G1", g1Checks, 38000],
    ["G2", g2Checks, 12000],
  ].map(([level, checks, durationMs]) => ({
    level,
    passed: true,
    specVersion: 1,
    startedAt: at,
    durationMs,
    summary: summary(checks),
    checks,
  }));
}

function estimateOf(expected) {
  return {
    estimate: {
      credits: { min: Math.ceil(0.6 * expected), expected, max: Math.ceil(1.6 * expected) },
      minutes: { min: 6, max: 14 },
    },
    cap: { credits: Math.max(10, Math.ceil(1.5 * expected)) },
  };
}

/** Build run events: plan → steps (ops_applied / file_written) → gates → run_finished. */
function buildEvents({ plan, ops, files, estimate, cap, reports, used, fixNote }) {
  const ev = [];
  const push = (type, payload) => ev.push({ type, payload });
  push("run_started", { kind: "build", mode: "create", baseRevision: 0, credits: { estimate, cap } });
  push("plan_ready", { steps: plan.map(({ id, kind, title }) => ({ id, kind, title })) });
  let revision = 0;
  let spent = 0;
  const perStep = used / plan.length;
  const codeSteps = plan.filter((p) => p.kind === "code");
  for (const step of plan) {
    push("step_started", { step: step.id, label_ru: step.title, attempt: 1 });
    if (step.kind === "ops") {
      const types = new Set((step.targets ?? []).flatMap((t) => TARGET_OPS[t] ?? []));
      const mine = ops.filter((o) => types.has(o.op));
      if (mine.length > 0) {
        revision++;
        push("ops_applied", {
          revision,
          opsCount: mine.length,
          opTypes: [...new Set(mine.map((o) => o.op))],
          summary_ru: opsSummary(mine),
        });
      }
    } else {
      const prefix = step.targets?.[0] ?? "";
      const mine = files.filter((f) => f.path.startsWith(prefix));
      const share = codeSteps.length > 1 ? mine : files;
      for (const f of share)
        push("file_written", {
          path: f.path,
          action: "create",
          sha256: f.sha256,
          size: f.size,
          revision: null,
        });
      push("agent_message", {
        agent: "builder",
        messageId: `msg-${step.id}`,
        text: `Готово: ${step.title.toLowerCase()}.`,
      });
      if (fixNote && step === codeSteps[0])
        push("agent_message", { agent: "qa", messageId: `msg-${step.id}-fix`, text: fixNote });
    }
    spent = Math.round((spent + perStep) * 1000) / 1000;
    push("budget_update", { used: spent, cap, estimate });
    push("step_finished", {
      step: step.id,
      durationMs: 40_000,
      ...(step === codeSteps[0] ? { ruFallback: true } : {}),
    });
  }
  revision++;
  for (const r of reports) {
    push("gate_started", { level: r.level, revision });
    push("gate_result", {
      level: r.level,
      passed: r.passed,
      revision,
      durationMs: r.durationMs,
      failedChecks: [],
      totalChecks: r.checks.length,
    });
  }
  push("run_finished", {
    status: "succeeded",
    resultRevision: revision,
    creditsUsed: used,
    summary_ru: `Собрал за 9 минут и ${String(used).replace(".", ",")} кредита. Проверьте систему от лица разных ролей.`,
    prodUrl: null,
  });
  return ev;
}

const sha = (s) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
};

function previewInfo(spec) {
  return {
    theme: spec.theme ?? {},
    roles: spec.roles.map((r) => ({ name: r.name, label: r.label, access: r.access })),
    pages: spec.pages.map((p) => ({ route: p.route, title: p.title, roles: p.roles })),
  };
}

function forum() {
  const lines = read("tools/fixtures/demo/forum.jsonl")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const tool = (name) =>
    lines
      .flatMap((l) => l.response.toolCalls ?? [])
      .filter((t) => t.name === name)
      .map((t) => t.args);
  const [analysis] = tool("submit_analysis");
  const [{ questions }] = tool("ask_questions");
  const [cardArgs] = tool("submit_card");
  const [{ steps: plan }] = tool("submit_plan");
  const ops = tool("apply_ops").flatMap((a) => a.ops);
  const files = tool("write_file").map((f) => ({
    path: f.path,
    sha256: sha(f.content),
    size: f.content.length,
  }));
  const spec = JSON.parse(read("specs/appspec/examples/forum.json"));
  const brief = lines[0].request.messages[0].content;
  const { estimate, cap } = estimateOf(20);
  const card = { cardVersion: 1, kind: "create", ...cardArgs, estimate, cap };
  const reports = gateReports(card.acceptance);
  return {
    name: "forum",
    brief,
    system: { name: card.title, slug: "severnyi-riteil" },
    ...previewInfo(spec),
    interview: {
      text: `Разложил задачу: ${analysis.roles.length} ролей, ${analysis.entities.length} видов данных, ${analysis.integrations.length} подключения. Осталось ${questions.length} развилок — ответьте кнопками.`,
      analysis: {
        title: card.title,
        roles: analysis.roles.map((r) => r.label),
        skeleton: analysis.skeleton,
        constraints: analysis.constraints,
        forks: [
          ...analysis.resolved.map((r) => ({ forkId: r.forkId, status: "resolved" })),
          ...questions.map((q, i) => ({ forkId: q.forkId, status: i === 0 ? "asking" : "pending" })),
        ],
      },
      questions,
    },
    card,
    cardEdit: {
      text: "добавь лист ожидания VIP",
      acceptance: {
        id: "AC9",
        text: "Когда VIP-билеты закончились, участник встаёт в лист ожидания",
        check: { type: "scenario", role: "participant", entity: "ticket" },
      },
    },
    build: buildEvents({
      plan,
      ops,
      files,
      estimate: estimate.credits.expected,
      cap: cap.credits,
      reports,
      used: 18.4,
      fixNote:
        "Тест AC1 упал: третий участник смог купить билет в заполненный поток. Добавил проверку вместимости потока в registerTicket, тест прошёл.",
    }),
    gates: reports,
  };
}

function bakery() {
  const spec = JSON.parse(read("specs/appspec/examples/bakery.json"));
  const questions = [
    {
      id: "q1",
      forkId: "F-PAYMENT",
      text: "Как принимать оплату за торт?",
      whyItMatters: "От способа оплаты зависит, когда заказ уходит в производство.",
      options: [
        { id: "yookassa_prepay", label: "Предоплата 50% онлайн", recommended: true },
        { id: "yookassa_full", label: "Полная оплата онлайн", recommended: false },
        { id: "on_pickup", label: "Оплата при получении", recommended: false },
      ],
      allowCustom: true,
    },
    {
      id: "q2",
      forkId: "F-LOGIN",
      text: "Как покупателям входить в систему?",
      whyItMatters: "Вход нужен, чтобы видеть свои заказы и получать уведомления.",
      options: [
        { id: "email", label: "По коду на почту", recommended: false },
        { id: "telegram", label: "Через Telegram", recommended: true },
      ],
      allowCustom: true,
    },
    {
      id: "q3",
      forkId: "F-RETENTION",
      text: "Сколько хранить контакты покупателей?",
      whyItMatters: "Чем короче срок, тем меньше риск по закону о персональных данных.",
      options: [
        { id: "d90", label: "90 дней после заказа", recommended: true },
        { id: "y1", label: "1 год", recommended: false },
      ],
      allowCustom: true,
    },
  ];
  const plan = [
    {
      id: "P1",
      kind: "ops",
      title: "Роли и данные: изделия, опции, заказы, слоты, платежи",
      targets: ["roles", "entities"],
    },
    {
      id: "P2",
      kind: "ops",
      title: "Права и подключения",
      targets: ["permissions", "workflows", "integrations"],
    },
    {
      id: "P3",
      kind: "ops",
      title: "Функции, экраны и критерии приёмки",
      targets: ["functions", "pages", "acceptance", "compliance"],
    },
    { id: "P4", kind: "code", title: "Экраны и расчёт цены", targets: [""] },
  ];
  const ops = [
    { op: "set_app" },
    ...spec.roles.map(() => ({ op: "add_role" })),
    ...spec.entities.map(() => ({ op: "add_entity" })),
    ...spec.permissions.map(() => ({ op: "set_permission" })),
    ...spec.workflows.map(() => ({ op: "add_workflow" })),
    ...spec.integrations.map(() => ({ op: "add_integration" })),
    ...spec.functions.map(() => ({ op: "add_function" })),
    ...spec.pages.map(() => ({ op: "add_page" })),
    { op: "set_acceptance" },
  ];
  const files = [...spec.functions, ...spec.pages].map((x) => ({
    path: x.file,
    sha256: sha(x.file),
    size: 1200,
  }));
  const { estimate, cap } = estimateOf(16);
  const acceptance = spec.acceptance.map((a) => ({ id: a.id, text: a.text, check: { type: a.check.type } }));
  const card = {
    cardVersion: 1,
    kind: "create",
    title: spec.app.name,
    summary: spec.app.description,
    segment: "made_to_order",
    roles: spec.roles.map((r) => ({
      name: r.name,
      label: r.label,
      access: r.access,
      description: r.label,
      can: [],
    })),
    data: spec.entities.map((e) => ({
      name: e.name,
      label: e.label,
      fields: e.fields.slice(0, 12).map((f) => ({ label: f.label, kind: "text" })),
      pii: e.fields.some((f) => f.pii) ? "basic" : "none",
    })),
    specVsCode: {
      spec: [
        "Данные: изделия, опции, заказы, слоты производства, платежи",
        "Кто что видит: покупатель — только свои заказы",
      ],
      code: ["Экраны: конфигуратор торта, мои заказы, производство, каталог", "Расчёт цены на сервере"],
    },
    screens: spec.pages.map((p) => ({ route: p.route, title: p.title, roles: p.roles, purpose: p.title })),
    integrations: spec.integrations.map((i) => ({
      connector: i.connector ?? i.type,
      purpose: i.name,
      ...((i.connector ?? i.type) === "yookassa" ? { userActionRequired: "подключить магазин ЮKassa" } : {}),
    })),
    automations: [],
    acceptance,
    pii: {
      categories: ["fio", "phone"],
      fields: [],
      retention: [],
      consent: true,
      summary: "Храним имя и телефон покупателей для связи по заказу.",
    },
    assumptions: ["Предоплата 50% через ЮKassa (по рекомендации)"],
    outOfScope: [],
    forkAnswers: [],
    estimate,
    cap,
  };
  const reports = gateReports(acceptance, { g0: 10, g2Warn: false });
  return {
    name: "bakery",
    brief: `Нужна система для кондитерской. ${spec.app.description}`,
    system: { name: spec.app.name, slug: "konditerskaya-sahar" },
    ...previewInfo(spec),
    interview: {
      text: `Разложил задачу: ${spec.roles.length} роли, ${spec.entities.length} видов данных. Осталось ${questions.length} развилки.`,
      analysis: {
        title: spec.app.name,
        roles: spec.roles.map((r) => r.label),
        skeleton: ["catalog", "application", "payment", "fulfillment"],
        constraints: ["Производство к дате по загрузке"],
        forks: questions.map((q, i) => ({ forkId: q.forkId, status: i === 0 ? "asking" : "pending" })),
      },
      questions,
    },
    card,
    cardEdit: {
      text: "добавь доставку курьером",
      acceptance: {
        id: "AC8",
        text: "Покупатель выбирает доставку курьером и видит её цену",
        check: { type: "scenario" },
      },
    },
    build: buildEvents({
      plan,
      ops,
      files,
      estimate: estimate.credits.expected,
      cap: cap.credits,
      reports,
      used: 14.2,
    }),
    gates: reports,
  };
}

for (const feed of [forum(), bakery()]) {
  writeFileSync(join(OUT, `${feed.name}.json`), `${JSON.stringify(feed, null, 2)}\n`);
  console.log(
    `feeds/${feed.name}.json: ${feed.build.length} событий сборки, ${feed.interview.questions.length} вопросов`,
  );
}
