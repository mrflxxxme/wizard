// --dry-run stub for spec_only: an OpenAI-compatible answer without network. The spec is built from the brief's
// `expected` in the AppSpec shape (specs/appspec/appspec.schema.json); every third brief first answers with
// broken JSON to exercise the retry loop with feedback.

import { parseExpectation } from "./score.mjs";

const IDENT = /^[a-z][a-z0-9_]{0,39}$/;

/** First latin pattern of an expectation as an AppSpec ident, else `${prefix}_${i}`. */
function ident(item, prefix, i, used) {
  const latin = parseExpectation(item)
    .patterns.map((p) => p.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
    .find((p) => IDENT.test(p));
  let name = latin ?? `${prefix}_${i + 1}`;
  if (used.has(name)) name = `${name}_${i + 1}`;
  used.add(name);
  return name;
}

const label = (item) => parseExpectation(item).label.slice(0, 80);

export function buildSpec(brief) {
  const ex = brief.expected;
  const used = new Set();
  const roles = ex.roles.map((r, i) => ({
    name: ident(r, "role", i, used),
    label: label(r),
    access: "login",
    loginMethods: ["email_otp"],
    ...(i === 0 ? { isAdmin: true } : {}),
  }));
  const entities = ex.entities.map((e, i) => ({
    name: ident(e, "entity", i, used),
    label: label(e),
    fields: [
      { name: "title", label: "Название", type: "string", required: true },
      {
        name: "status",
        label: "Статус",
        type: "enum",
        enum: [
          { value: "new", label: "Новая" },
          { value: "done", label: "Готово" },
        ],
      },
    ],
  }));
  const permissions = roles.flatMap((r, i) =>
    entities.map((e) => ({
      role: r.name,
      entity: e.name,
      ops: i === 0 ? ["read", "create", "update", "delete"] : ["read"],
    })),
  );
  return {
    specVersion: "1",
    app: { name: `Черновик: ${brief.title}`.slice(0, 80), locale: "ru" },
    roles,
    entities,
    permissions,
    workflows: [
      {
        name: "main_flow",
        label: "Основной процесс",
        trigger: { type: "on_create", entity: entities[0]?.name ?? "entity_1" },
        steps: [{ type: "notify", params: { features: ex.must_have_features.map(label) } }],
      },
    ],
    integrations: [{ name: "mail", connector: "email" }],
    pages: [{ route: "/", title: "Главная", file: "ui/Home.tsx", roles: roles.map((r) => r.name) }],
    acceptance: ex.acceptance_criteria.map((a, i) => ({
      id: `AC${i + 1}`,
      text: label(a),
      check: { type: "scenario" },
    })),
  };
}

export function stubCompletion({ brief, briefIndex, attempt, mode }) {
  const broken = briefIndex % 3 === 0 && attempt === 0;
  const payload = broken ? '{"specVersion": "1", "roles": [' : JSON.stringify(buildSpec(brief));
  const message =
    mode === "tools" && !broken
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_${briefIndex}_${attempt}`,
              type: "function",
              function: { name: "submit_app_spec", arguments: payload },
            },
          ],
        }
      : { role: "assistant", content: payload };
  const promptTokens = 9000 + brief.text.length;
  return {
    choices: [{ index: 0, message, finish_reason: broken ? "length" : "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: Math.ceil(payload.length / 3),
      prompt_tokens_details: { cached_tokens: attempt > 0 ? 8000 : 0 },
    },
  };
}
