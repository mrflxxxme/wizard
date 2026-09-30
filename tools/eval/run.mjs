#!/usr/bin/env node
// Eval-стенд Wizard (specs/quality/eval.yaml#modes).
//   spec_only (по умолчанию): бриф → AppSpec одним вызовом инструмента на нескольких моделях; валидация по
//     specs/appspec/appspec.schema.json, покрытие, латентность, токены, ₽, pii_leaks.
//   --harness: оркестратор → карточка → строитель → G0 → G1 (tools/eval/harness, TypeScript через tsx).
// Node 22. Запуск: node tools/eval/run.mjs [--harness] [--dry-run] [--llm-mode=fixture|live|record]
//   [--models=a,b|all] [--briefs=id,id] [--out=dir] [--mode=tools|json] [--response-format=none|json_object|json_schema]
//   [--max-retries=2] [--concurrency=2] [--config=path/to/models.json]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBriefs } from "./lib/briefs.mjs";
import { createLeakMeter } from "./lib/canary.mjs";
import { parseArgs, resultStamp } from "./lib/report.mjs";
import { loadAppSpecSchema, toolSchema, validateAppSpec } from "./lib/schema.mjs";
import { round, scoreSpec } from "./lib/score.mjs";
import { stubCompletion } from "./lib/stub.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const TOOL_NAME = "submit_app_spec";

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(await readFile(join(HERE, "README.md"), "utf8"));
  process.exit(0);
}
try {
  process.exitCode = args.harness ? await harness() : await specOnly();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

// ---------- harness: TypeScript packages through tsx (architecture.yaml#stack.dev_exec) ----------
async function harness() {
  let loader;
  for (const base of [import.meta.url, pathToFileURL(join(ROOT, "apps", "runtime", "package.json")).href]) {
    try {
      loader = createRequire(base).resolve("tsx");
      break;
    } catch {}
  }
  if (!loader) fail("не найден tsx: выполните pnpm install");
  const { register } = await import(pathToFileURL(join(dirname(loader), "esm", "api", "index.mjs")).href);
  register();
  const { runHarnessCli } = await import(pathToFileURL(join(HERE, "harness", "cli.ts")).href);
  return runHarnessCli(args);
}

// ---------- spec_only ----------
async function specOnly() {
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
    const unknown = want.filter((w) => !config.models.some((m) => m.id === w));
    if (unknown.length) fail(`неизвестные модели: ${unknown.join(", ")}`);
    models = config.models.filter((m) => want.includes(m.id));
  }
  if (!models.length) fail("нет моделей для прогона");
  const briefs = loadBriefs(args.briefs);
  if (!briefs.length) fail("нет брифов");

  if (!DRY) {
    for (const m of models) {
      const p = config.providers[m.provider];
      if (!p) fail(`модель ${m.id}: неизвестный провайдер ${m.provider}`);
      if (!process.env[p.apiKeyEnv])
        fail(`модель ${m.id}: не задан ${p.apiKeyEnv} (или запустите с --dry-run)`);
    }
  }

  const schema = toolSchema(loadAppSpecSchema());
  const SYSTEM_PROMPT = `Ты — архитектор платформы Wizard, которая собирает бизнес-системы по описанию в чате.
По брифу пользователя составь спецификацию приложения AppSpec (specVersion "1", app.locale "ru").

Правила:
- name сущностей, полей, ролей, воркфлоу и интеграций — латиницей в snake_case; label — по-русски.
- Поле type=ref ссылается на сущность этой же спеки через ref.entity; type=enum перечисляет варианты в enum.
- Поля с персональными данными помечай pii: basic (ФИО, телефон, email, адрес), special (здоровье и т. п.).
- permissions: role и entity — имена из этой же спеки, ops из read/create/update/delete; ограничение строк — rowFilter.
- pages: route, title, file (ui/…tsx) и roles — имена ролей, которые видят страницу.
- workflows: trigger и шаги (статусы, модерация, квоты, уведомления).
- integrations.connector: yookassa, telegram, email или qr. Оплата — только через yookassa, данные карт не собирать.
- acceptance — 5–10 проверяемых критериев приёмки на русском (id AC1…, check.type permission|scenario|constraint).
- Не выдумывай реальные ФИО, телефоны и адреса.

JSON Schema результата (specs/appspec/appspec.schema.json):
${JSON.stringify(schema)}`;
  const OUTPUT_INSTRUCTION = {
    tools: `Верни результат ОДНИМ вызовом инструмента ${TOOL_NAME}. Текст вне вызова не нужен.`,
    json: "Верни ТОЛЬКО один JSON-объект по схеме, без пояснений и без markdown.",
  };
  const isT1 = (m) => String(m.tier).startsWith("T1");

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
      body.tools = [
        {
          type: "function",
          function: { name: TOOL_NAME, description: "Сохранить AppSpec", parameters: schema },
        },
      ];
      const tc = model.tool_choice ?? defaults.tool_choice;
      body.tool_choice = tc === "force" ? { type: "function", function: { name: TOOL_NAME } } : tc;
    } else if (rf === "json_object") {
      body.response_format = { type: "json_object" };
    } else if (rf === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "app_spec",
          schema,
          strict: Boolean(model.json_schema_strict ?? defaults.json_schema_strict),
        },
      };
    }
    return body;
  }

  // Transport; every T1 payload goes through the leak meter first (inspected in memory, never stored).
  async function chat(model, body, ctx, meter) {
    const payload = JSON.stringify(body);
    if (isT1(model)) meter.inspectT1(payload);
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
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env[p.apiKeyEnv]}`,
          },
          body: payload,
          signal: AbortSignal.timeout(model.timeout_ms ?? defaults.timeout_ms),
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500)
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (!res.ok) return { httpError: `HTTP ${res.status}: ${text.slice(0, 500)}` }; // 4xx не ретраим
        return JSON.parse(text);
      } catch (e) {
        lastErr = e;
        await sleep(2000 * 2 ** i);
      }
    }
    return { httpError: String(lastErr?.message ?? lastErr) };
  }

  async function runOne(model, brief, briefIndex) {
    const mode = model.mode ?? defaults.mode;
    const meter = createLeakMeter({ canaries: brief.canaries });
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
      const resp = await chat(model, buildRequest(model, messages), { brief, briefIndex, attempt }, meter);
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
    const cost =
      ((usage.input - usage.cached) * (price.input ?? 0) +
        usage.cached * (price.cached_input ?? price.input ?? 0) +
        usage.output * (price.output ?? 0)) /
      1e6;
    const score = scoreSpec(result.ok ? result.spec : null, brief.expected);
    return {
      brief: brief.id,
      segment: brief.segment,
      model: model.id,
      tier: model.tier,
      mode,
      valid: result.ok,
      g0_pass: result.ok,
      attempts,
      finish_reason: finish,
      errors: result.ok ? [] : result.errors.slice(0, 30),
      latency_ms: {
        total: latencies.reduce((a, b) => a + b, 0),
        first: latencies[0] ?? null,
        per_attempt: latencies,
      },
      usage,
      cost_rub: round(cost, 4),
      pii_leaks: meter.leaks,
      score,
      spec: result.spec,
    };
  }

  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pct = (x) => `${Math.round(x * 100)}%`;

  function summarize(runs, skipped) {
    const lines = [];
    lines.push(`## Eval spec_only — ${new Date().toISOString()}${DRY ? " (DRY-RUN, заглушка)" : ""}`);
    lines.push("");
    lines.push(
      `Брифов: ${briefs.length}, моделей: ${models.length}, режим: ${defaults.mode}, ретраев на невалидный ответ: до ${MAX_RETRIES}.`,
    );
    lines.push("");
    lines.push(
      "| Модель | Уровень | Валидно | Попыток (ср.) | Скор | Роли | Сущности | Фичи | Приёмка | Латентность, с (ср.) | Вход / кэш / выход, ток. (ср.) | ₽ за бриф (ср.) | ₽ всего | pii_leaks |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const m of models) {
      const rs = runs.filter((r) => r.model === m.id);
      const s = (k) => avg(rs.map((r) => r.score[k]));
      lines.push(
        `| ${m.id} | ${m.tier ?? ""} | ${rs.filter((r) => r.valid).length}/${rs.length} | ${avg(rs.map((r) => r.attempts)).toFixed(1)} | **${s("total").toFixed(2)}** | ${pct(s("roles"))} | ${pct(s("entities"))} | ${pct(s("features"))} | ${pct(s("acceptance"))} | ${(avg(rs.map((r) => r.latency_ms.total)) / 1000).toFixed(1)} | ${Math.round(avg(rs.map((r) => r.usage.input)))} / ${Math.round(avg(rs.map((r) => r.usage.cached)))} / ${Math.round(avg(rs.map((r) => r.usage.output)))} | ${avg(rs.map((r) => r.cost_rub)).toFixed(2)} | ${rs.reduce((a, r) => a + r.cost_rub, 0).toFixed(2)} | ${rs.reduce((a, r) => a + r.pii_leaks, 0)} |`,
      );
    }
    lines.push("");
    lines.push(`| Бриф | ${models.map((m) => m.id).join(" | ")} |`);
    lines.push(`|---|${models.map(() => "---").join("|")}|`);
    for (const b of briefs) {
      const cells = models.map((m) => {
        const r = runs.find((x) => x.brief === b.id && x.model === m.id);
        if (!r) return "— (канарейки, не на T1)";
        return r.valid
          ? `${r.score.total.toFixed(2)}${r.attempts > 1 ? ` (${r.attempts} поп.)` : ""}`
          : `✗ ${r.errors[0]?.slice(0, 40) ?? ""}`;
      });
      lines.push(`| ${b.id} | ${cells.join(" | ")} |`);
    }
    if (skipped.length) {
      lines.push("");
      lines.push(
        `Пропущено ${skipped.length}: брифы с ПДн-канарейками не отправляются на T1 в spec_only — в этом режиме нет scrub (в --harness их обрабатывает роутер).`,
      );
    }
    const misses = runs.filter((r) => r.valid && Object.values(r.score.missing).some((x) => x.length));
    if (misses.length) {
      lines.push("");
      lines.push("<details><summary>Чего не хватило (валидные ответы)</summary>");
      lines.push("");
      for (const r of misses) {
        const parts = Object.entries(r.score.missing)
          .filter(([, v]) => v.length)
          .map(([k, v]) => `${k}: ${v.join("; ")}`);
        lines.push(`- ${r.model} / ${r.brief} — ${parts.join(" · ")}`);
      }
      lines.push("");
      lines.push("</details>");
    }
    return lines.join("\n");
  }

  const started = new Date();
  const tasks = [];
  const skipped = [];
  briefs.forEach((b, bi) => {
    for (const m of models) {
      if (isT1(m) && b.canaries?.length) {
        skipped.push({ brief: b.id, model: m.id, reason: "canaries_not_sent_to_T1" });
        continue;
      }
      tasks.push(async () => {
        const r = await runOne(m, b, bi);
        log(r);
        return r;
      });
    }
  });
  const runs = await pool(tasks, CONCURRENCY);

  const outDir = resolve(typeof args.out === "string" ? args.out : join(HERE, "results"));
  await mkdir(outDir, { recursive: true });
  const summary = summarize(runs, skipped);
  const out = {
    mode: "spec_only",
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    dry_run: DRY,
    settings: { ...defaults, max_retries: MAX_RETRIES, concurrency: CONCURRENCY },
    models: models.map(({ id, tier, provider, model, price, extra_body, mode, response_format }) => ({
      id,
      tier,
      provider,
      model,
      price,
      extra_body,
      mode,
      response_format,
    })),
    briefs: briefs.map((b) => b.id),
    runs,
    skipped,
  };
  const file = join(outDir, `${resultStamp(started)}-spec_only${DRY ? "-dry" : ""}.json`);
  await writeFile(file, JSON.stringify(out, null, 2));
  await writeFile(file.replace(/\.json$/, ".md"), `${summary}\n`);
  console.log(`\n${summary}\n`);
  console.log(`Результаты: ${file}`);
  const leaks = runs.reduce((a, r) => a + r.pii_leaks, 0);
  if (leaks > 0) {
    console.error(`Порог нарушен: pii_leaks = ${leaks} (должно быть 0).`);
    return 1;
  }
  return 0;
}

// ---------- helpers ----------
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
function log(r) {
  process.stderr.write(
    `${r.valid ? "✓" : "✗"} ${r.model.padEnd(22)} ${r.brief.padEnd(28)} score=${r.score.total.toFixed(2)} attempts=${r.attempts} ${(r.latency_ms.total / 1000).toFixed(1)}s ${r.cost_rub.toFixed(2)}₽\n`,
  );
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function fail(msg) {
  console.error(`Ошибка: ${msg}`);
  process.exit(1);
}
