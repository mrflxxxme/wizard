// Заглушка для --dry-run: имитирует ответ OpenAI-совместимого API без сети.
// Спеку собирает из expected брифа; каждый третий бриф сначала отвечает битым JSON,
// чтобы прогнать цикл ретраев с обратной связью.

import { parseExpectation } from "./score.mjs";

const first = (item) => parseExpectation(item).patterns[0];
const slug = (s, i) => (s.replace(/[^a-zа-я0-9]+/gi, "_").replace(/^_|_$/g, "") || "x") + (i ? `_${i}` : "");

function buildSpec(brief) {
  const ex = brief.expected;
  const roles = ex.roles.map((r, i) => ({ id: slug(first(r), 0) || `role${i}`, name: parseExpectation(r).label }));
  const entities = ex.entities.map((e) => ({
    name: slug(first(e), 0),
    label: parseExpectation(e).label,
    fields: [
      { name: "title", type: "string", required: true, pdn: "none" },
      { name: "status", type: "enum", options: ["new", "in_progress", "done"] },
    ],
  }));
  const permissions = roles.flatMap((r, i) =>
    entities.map((e) => ({ role: r.id, entity: e.name, actions: i === 0 ? ["create", "read", "update", "delete", "list"] : ["read", "list"], scope: i === 0 ? "all" : "own" })),
  );
  return {
    title: `Черновик: ${brief.title}`,
    summary: brief.text.slice(0, 160),
    roles,
    entities,
    permissions,
    pages: [{ id: "home", title: "Главная", roles: roles.map((r) => r.id), purpose: "стартовый экран" }],
    workflows: [{ name: "Основной процесс", trigger: "создание записи", steps: ex.must_have_features.map((f) => parseExpectation(f).label) }],
    integrations: [{ kind: "email", purpose: "уведомления" }],
    acceptance: ex.acceptance_criteria.map((a) => parseExpectation(a).label).concat(["Все роли видят только свои данные"]).slice(0, 8),
  };
}

export function stubCompletion({ brief, briefIndex, attempt, mode }) {
  const broken = briefIndex % 3 === 0 && attempt === 0;
  const payload = broken ? '{"title": "Черновик", "roles": [' : JSON.stringify(buildSpec(brief));
  const message =
    mode === "tools" && !broken
      ? { role: "assistant", content: null, tool_calls: [{ id: `call_${briefIndex}_${attempt}`, type: "function", function: { name: "submit_app_spec", arguments: payload } }] }
      : { role: "assistant", content: payload };
  const promptTokens = 2600 + brief.text.length;
  return {
    choices: [{ index: 0, message, finish_reason: broken ? "length" : "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: Math.ceil(payload.length / 3),
      prompt_tokens_details: { cached_tokens: attempt > 0 ? 2000 : 0 },
    },
  };
}
