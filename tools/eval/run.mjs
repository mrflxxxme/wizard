#!/usr/bin/env node
// Eval-стенд Wizard: бриф → AppSpec draft на нескольких моделях, валидация, покрытие, латентность, токены, ₽.
// Node 22, без зависимостей. Запуск: node tools/eval/run.mjs [--dry-run] [--models=a,b|all] [--briefs=id,id]
//   [--mode=tools|json] [--response-format=none|json_object|json_schema] [--max-retries=2] [--concurrency=2]
//   [--config=path/to/models.json]

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SPEC_SCHEMA, FIELD_TYPES, ACTIONS, INTEGRATIONS, validateAppSpec } from "./lib/appspec.mjs";
import { scoreSpec, round } from "./lib/score.mjs";
import { stubCompletion } from "./lib/stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_NAME = "submit_app_spec";

// ---------- CLI ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
if (args.help || args.h) {
  console.log(await readFile(join(HERE, "README.md"), "utf8"));
  process.exit(0);
}
const DRY = Boolean(args["dry-run"]);
const MAX_RETRIES = Number(args["max-retries"] ?? 2);
const CONCURRENCY = Math.max(1, Number(args.concurrency ?? 2));

const config = JSON.parse(await readFile(resolve(args.config ?? join(HERE, "models.json")), "utf8"));
const defaults = { ...config.defaults };
if (args.mode) defaults.mode = args.mode;
if (args["response-format"]) defaults.response_format = args["response-format"];

let models = config.models.filter((m) => m.enabled);
if (args.models === "all") models = config.models;
else if (typeof args.models === "string") {
  const want = args.models.split(",");
  models = config.models.filter((m) => want.includes(m.id));
  const unknown = want.filter((w) => !config.models.some((m) => m.id === w));
  if (unknown.length) fail(`неизвестные модели: ${unknown.join(", ")}`);
}
if (!models.length) fail("нет моделей для прогона");

const briefFiles = (await readdir(join(HERE, "briefs"))).filter((f) => f.endsWith(".json")).sort();
let briefs = await Promise.all(briefFiles.map(async (f) => JSON.parse(await readFile(join(HERE, "briefs", f), "utf8"))));
if (typeof args.briefs === "string") {
  const want = args.briefs.split(",");
  briefs = briefs.filter((b) => want.includes(b.id));
}
if (!briefs.length) fail("нет брифов");

if (!DRY) {
  for (const m of models) {
    const p = config.providers[m.provider];
    if (!p) fail(`модель ${m.id}: неизвестный провайдер ${m.provider}`);
    if (!process.env[p.apiKeyEnv]) fail(`модель ${m.id}: не задан ${p.apiKeyEnv} (или запустите с --dry-run)`);
  }
}

// ---------- промпт ----------
const SYSTEM_PROMPT = `Ты — архитектор платформы Wizard, которая собирает бизнес-системы по описанию в чате.
По брифу пользователя составь черновик спецификации приложения (AppSpec draft).

Правила:
- Сущности и поля — латиницей в snake_case; label — по-русски. Типы полей: ${FIELD_TYPES.join(", ")}.
- Для type=reference укажи ref = имя сущности из этой же спеки; для type=enum — options.
- Для каждого поля с персональными данными укажи pdn: common (ФИО, телефон, email, адрес), special (здоровье и т. п.), иначе none.
- roles[].id — латиницей; permissions ссылаются на roles[].id и entities[].name. Действия: ${ACTIONS.join(", ")}; scope: all | own | assigned.
- pages[].roles — id ролей, которые видят страницу.
- workflows — статусы, модерация, квоты, уведомления: trigger и шаги.
- integrations.kind: ${INTEGRATIONS.join(", ")}. Оплата — только через yookassa, данные карт не собирать.
- acceptance — 5–10 проверяемых критериев приёмки на русском.
- Не выдумывай реальные ФИО, телефоны и адреса.

JSON Schema результата:
${JSON.stringify(APP_SPEC_SCHEMA)}`;

const OUTPUT_INSTRUCTION = {
  tools: `Верни результат ОДНИМ вызовом инструмента ${TOOL_NAME}. Текст вне вызова не нужен.`,
  json: "Верни ТОЛЬКО один JSON-объект по схеме, без пояснений и без markdown.",
};

function buildRequest(model, messages) {
  const mode = model.mode ?? defaults.mode;
  const rf = model.response_format ?? defaults.response_format;
  const body = {
    model: model.model,
    messages,
    temperature: model.temperature ?? defaults.temperature,
    max_tokens: model.max_tokens ?? defaults.max_tokens,
    ...(model.extra_body ?? {}),
  };
  if (mode === "tools") {
    body.tools = [{ type: "function", function: { name: TOOL_NAME, description: "Сохранить черновик AppSpec", parameters: APP_SPEC_SCHEMA } }];
    const tc = model.tool_choice ?? defaults.tool_choice;
    body.tool_choice = tc === "force" ? { type: "function", function: { name: TOOL_NAME } } : tc;
  } else if (rf === "json_object") {
    body.response_format = { type: "json_object" };
  } else if (rf === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: "app_spec", schema: APP_SPEC_SCHEMA, strict: Boolean(model.json_schema_strict ?? defaults.json_schema_strict) } };
  }
  return body;
}

// ---------- транспорт ----------
async function chat(model, body, ctx) {
  if (DRY) {
    await sleep(5 + Math.random() * 20);
    return stubCompletion({ ...ctx, mode: model.mode ?? defaults.mode });
  }
  const p = config.providers[model.provider];
  const base = (process.env[p.baseUrlEnv] || p.defaultBaseUrl).replace(/\/+$/, "");
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env[p.apiKeyEnv]}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(model.timeout_ms ?? defaults.timeout_ms),
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (!res.ok) return { httpError: `HTTP ${res.status}: ${text.slice(0, 500)}` }; // 4xx не ретраим
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await sleep(2000 * 2 ** i);
    }
  }
  return { httpError: String(lastErr?.message ?? lastErr) };
}

// ---------- один прогон бриф × модель ----------
async function runOne(model, brief, briefIndex) {
  const mode = model.mode ?? defaults.mode;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Бриф:\n${brief.text}\n\n${OUTPUT_INSTRUCTION[mode]}` },
  ];
  const usage = { input: 0, cached: 0, output: 0 };
  const latencies = [];
  let result = { ok: false, spec: null, errors: ["нет ответа"] };
  let attempts = 0;
  let finish = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attempts++;
    const t0 = performance.now();
    const resp = await chat(model, buildRequest(model, messages), { brief, briefIndex, attempt });
    latencies.push(Math.round(performance.now() - t0));
    if (resp.httpError) {
      result = { ok: false, spec: null, errors: [resp.httpError] };
      break;
    }
    const u = resp.usage ?? {};
    usage.input += u.prompt_tokens ?? 0;
    usage.output += u.completion_tokens ?? 0;
    usage.cached += u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;

    const msg = resp.choices?.[0]?.message ?? {};
    finish = resp.choices?.[0]?.finish_reason ?? null;
    const call = msg.tool_calls?.find((c) => c.function?.name === TOOL_NAME) ?? msg.tool_calls?.[0];
    const raw = call ? call.function.arguments : msg.content;
    result = validateAppSpec(raw ?? "");
    if (result.ok) break;

    const feedback = `Ответ не прошёл валидацию${finish === "length" ? " (ответ обрезан по длине — пиши компактнее)" : ""}:\n- ${result.errors.slice(0, 20).join("\n- ")}\nИсправь и верни полный AppSpec заново тем же способом.`;
    if (call) {
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: [call] });
      messages.push({ role: "tool", tool_call_id: call.id, content: feedback });
    } else {
      messages.push({ role: "assistant", content: String(msg.content ?? "").slice(0, 20000) });
      messages.push({ role: "user", content: feedback });
    }
  }

  const price = model.price ?? {};
  const cost = ((usage.input - usage.cached) * (price.input ?? 0) + usage.cached * (price.cached_input ?? price.input ?? 0) + usage.output * (price.output ?? 0)) / 1e6;
  const score = scoreSpec(result.ok ? result.spec : null, brief.expected);
  return {
    brief: brief.id,
    segment: brief.segment,
    model: model.id,
    tier: model.tier,
    mode,
    valid: result.ok,
    attempts,
    finish_reason: finish,
    errors: result.ok ? [] : result.errors.slice(0, 30),
    latency_ms: { total: latencies.reduce((a, b) => a + b, 0), first: latencies[0] ?? null, per_attempt: latencies },
    usage,
    cost_rub: round(cost, 4),
    score,
    spec: result.spec,
  };
}

// ---------- пул ----------
async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

// ---------- отчёт ----------
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x) => `${Math.round(x * 100)}%`;

function summarize(runs) {
  const lines = [];
  lines.push(`## Eval AppSpec draft — ${new Date().toISOString()}${DRY ? " (DRY-RUN, заглушка)" : ""}`);
  lines.push("");
  lines.push(`Брифов: ${briefs.length}, моделей: ${models.length}, режим: ${defaults.mode}, ретраев на невалидный ответ: до ${MAX_RETRIES}.`);
  lines.push("");
  lines.push("| Модель | Уровень | Валидно | Попыток (ср.) | Скор | Роли | Сущности | Фичи | Приёмка | Латентность, с (ср.) | Вход / кэш / выход, ток. (ср.) | ₽ за бриф (ср.) | ₽ всего |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m.id);
    const s = (k) => avg(rs.map((r) => r.score[k]));
    lines.push(
      `| ${m.id} | ${m.tier ?? ""} | ${rs.filter((r) => r.valid).length}/${rs.length} | ${avg(rs.map((r) => r.attempts)).toFixed(1)} | **${s("total").toFixed(2)}** | ${pct(s("roles"))} | ${pct(s("entities"))} | ${pct(s("features"))} | ${pct(s("acceptance"))} | ${(avg(rs.map((r) => r.latency_ms.total)) / 1000).toFixed(1)} | ${Math.round(avg(rs.map((r) => r.usage.input)))} / ${Math.round(avg(rs.map((r) => r.usage.cached)))} / ${Math.round(avg(rs.map((r) => r.usage.output)))} | ${avg(rs.map((r) => r.cost_rub)).toFixed(2)} | ${rs.reduce((a, r) => a + r.cost_rub, 0).toFixed(2)} |`,
    );
  }
  lines.push("");
  lines.push(`| Бриф | ${models.map((m) => m.id).join(" | ")} |`);
  lines.push(`|---|${models.map(() => "---").join("|")}|`);
  for (const b of briefs) {
    const cells = models.map((m) => {
      const r = runs.find((x) => x.brief === b.id && x.model === m.id);
      return r.valid ? `${r.score.total.toFixed(2)}${r.attempts > 1 ? ` (${r.attempts} поп.)` : ""}` : `✗ ${r.errors[0]?.slice(0, 40) ?? ""}`;
    });
    lines.push(`| ${b.id} | ${cells.join(" | ")} |`);
  }
  const misses = runs.filter((r) => r.valid && Object.values(r.score.missing).some((x) => x.length));
  if (misses.length) {
    lines.push("");
    lines.push("<details><summary>Чего не хватило (валидные ответы)</summary>");
    lines.push("");
    for (const r of misses) {
      const parts = Object.entries(r.score.missing).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join("; ")}`);
      lines.push(`- ${r.model} / ${r.brief} — ${parts.join(" · ")}`);
    }
    lines.push("");
    lines.push("</details>");
  }
  return lines.join("\n");
}

// ---------- main ----------
const started = new Date();
const tasks = [];
briefs.forEach((b, bi) => models.forEach((m) => tasks.push(() => runOne(m, b, bi).then((r) => (log(r), r)))));
const runs = await pool(tasks, CONCURRENCY);

const stamp = started.toISOString().replace(/[:.]/g, "-");
const outDir = join(HERE, "results");
await mkdir(outDir, { recursive: true });
const summary = summarize(runs);
const out = {
  started_at: started.toISOString(),
  finished_at: new Date().toISOString(),
  dry_run: DRY,
  settings: { ...defaults, max_retries: MAX_RETRIES, concurrency: CONCURRENCY },
  models: models.map(({ id, tier, provider, model, price, extra_body, mode, response_format }) => ({ id, tier, provider, model, price, extra_body, mode, response_format })),
  briefs: briefs.map((b) => b.id),
  runs,
};
const file = join(outDir, `${stamp}${DRY ? "-dry" : ""}.json`);
await writeFile(file, JSON.stringify(out, null, 2));
await writeFile(file.replace(/\.json$/, ".md"), summary + "\n");
console.log("\n" + summary + "\n");
console.log(`Результаты: ${file}`);

function log(r) {
  process.stderr.write(`${r.valid ? "✓" : "✗"} ${r.model.padEnd(22)} ${r.brief.padEnd(24)} score=${r.score.total.toFixed(2)} attempts=${r.attempts} ${(r.latency_ms.total / 1000).toFixed(1)}s ${r.cost_rub.toFixed(2)}₽\n`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function fail(msg) {
  console.error(`Ошибка: ${msg}`);
  process.exit(1);
}
