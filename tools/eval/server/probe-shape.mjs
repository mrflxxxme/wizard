// V3-18: the shape probe of v3 (step «≤ 30 ₽ probe» of the lean harness ladder, agents/builder-v3.md §4). The route
// probe (probe.mjs) sends one trivial message per route head; checkpoint 1 then failed where the production requests
// differ from it: critic_visual (0 of 2 attempts, fast refusals) and techreview (2 of 7). This probe sends the
// production SHAPES on synthetic content, model by model of the route's chain, with variants that isolate the cause:
//   critic_visual (kimi-k2.6, qwen3.6-35b): as in the build — the real system prompt, the critique text, six JPEGs of
//     the shot plan and submit_critique with toolChoice required; when that is not usable, also 1 JPEG / 6 JPEGs
//     without a tool, required + 1 JPEG, required without images, toolChoice auto, and the answer as JSON text
//     (callTool textArgs);
//   techreview (deepseek-v4-pro, gpt-oss-120b, gigachat-3.5, kimi-k2.6): as in the build — the reviewer's prompt, a
//     synthetic digest of the size the fixture v3 build makes and submit_techreview with toolChoice required; for the
//     first two also a digest twice that size and the second turn after a refused answer (callTool's repair); when the
//     build shape is not usable, also toolChoice auto and the answer as JSON text.
// Every variant goes through the server's own gateway (@wizard/llm createRouter with the pod's keys, a registry whose
// route is the one model under test, a fresh circuit breaker), usage into platform.llm_calls of an eval org as the
// route probe writes it. A failed variant gets one direct call of the same request to the provider
// (provider-call.mjs, as `diagnose` does): the HTTP status and the provider's text ≤ 300 chars, keys masked — the
// content is synthetic, so that text stays within the data boundary; packages/llm is not changed. The cap: no call
// starts once the spend reached it, nor when its upper bound (input estimate + the route's max_tokens) would pass it.
//
// Request content: probe-shape-prompts.json (the real prompts and tools of @wizard/agents on the synthetic clinic and
// workshop of its fixtures; tools/eval/test/v3-probe.test.ts keeps them equal and rewrites them with
// WIZARD_UPDATE_PROBE_SHAPE=1) and probe-shape-images.json (probe-shape-images.mjs). Both ship to the pod over stdin
// inside the script, like the route probe.
import { readFileSync } from "node:fs";
import { PROBE_MAX_CAP_RUB } from "./probe.mjs";
import { openAiBody, providerCall } from "./provider-call.mjs";

/** Groups of the shape probe and their call types. */
export const SHAPE_CALL_TYPES = { critic: "critic_visual", techreview: "techreview" };
export const SHAPE_GROUPS = Object.keys(SHAPE_CALL_TYPES);

/** The T0 chains of the routes (models.yaml#routes; a test keeps them equal to the registry). */
export const SHAPE_CHAINS = {
  critic: ["kimi-k2.6", "qwen3.6-35b"],
  techreview: ["deepseek-v4-pro", "gpt-oss-120b", "gigachat-3.5", "kimi-k2.6"],
};

/** Prices, ₽ per 1M tokens with VAT, and the image rule of the probed models (models.yaml; a test keeps them equal). */
export const SHAPE_MODELS = {
  "kimi-k2.6": { price: { input: 175.68, cached: 175.68, output: 725.9 }, image: { px: 28, max: 16384 } },
  "qwen3.6-35b": { price: { input: 219.6, cached: 219.6, output: 329.4 }, image: { px: 32, max: 16384 } },
  "deepseek-v4-pro": { price: { input: 183, cached: 183, output: 732 } },
  "gpt-oss-120b": { price: { input: 15.86, cached: 15.86, output: 61 } },
  "gigachat-3.5": { price: { input: 96.22, cached: 96.22, output: 288.6 } },
};

/** The routes' answer limits (models.yaml#routes; a test keeps them equal). */
export const SHAPE_ROUTES = {
  critic: { maxTokens: 4000, timeoutMs: 180_000 },
  techreview: { maxTokens: 8000, timeoutMs: 300_000 },
};

/**
 * Variants. `when` — run only when that variant of the same model was not usable (a router error, no tool call,
 * arguments that fail the tool's check); `stage` — the round of the conditional ones (cheap analysis, then the
 * candidate fixes, then the costly analysis); `models` — only for these models. `images` — how many of the six JPEGs;
 * `prompt` — real (the build's) | short (a one-word question) | json (real + «answer as JSON text», no tool).
 */
export const SHAPE_VARIANTS = {
  critic: [
    {
      id: "prod",
      short: "как в сборке",
      label: "как в сборке: required + 6 JPEG",
      prompt: "real",
      images: 6,
      toolChoice: "required",
    },
    {
      id: "img1",
      short: "1 JPEG",
      label: "1 JPEG, без инструмента",
      prompt: "short",
      images: 1,
      when: "prod",
      stage: 1,
    },
    {
      id: "img6",
      short: "6 JPEG",
      label: "6 JPEG, без инструмента",
      prompt: "short",
      images: 6,
      when: "prod",
      stage: 1,
    },
    {
      id: "auto6",
      short: "auto+6 JPEG",
      label: "tool_choice auto + 6 JPEG",
      prompt: "real",
      images: 6,
      toolChoice: "auto",
      when: "prod",
      stage: 2,
    },
    {
      id: "json6",
      short: "JSON текстом+6 JPEG",
      label: "JSON текстом без инструмента + 6 JPEG",
      prompt: "json",
      images: 6,
      when: "prod",
      stage: 2,
    },
    {
      id: "req1",
      short: "required+1 JPEG",
      label: "required + 1 JPEG",
      prompt: "real",
      images: 1,
      toolChoice: "required",
      when: "prod",
      stage: 3,
    },
    {
      id: "req0",
      short: "required без картинок",
      label: "required без картинок",
      prompt: "real",
      images: 0,
      toolChoice: "required",
      when: "req1",
      stage: 3,
    },
  ],
  techreview: [
    {
      id: "prod",
      short: "как в сборке",
      label: "как в сборке: required, сводка ×1",
      prompt: "real",
      digest: 1,
      toolChoice: "required",
    },
    {
      id: "x2",
      short: "сводка ×2",
      label: "required, сводка ×2",
      prompt: "real",
      digest: 2,
      toolChoice: "required",
      models: ["deepseek-v4-pro", "gpt-oss-120b"],
    },
    {
      id: "repair",
      short: "второй ход",
      label: "второй ход после отказа проверки (повтор callTool)",
      prompt: "real",
      digest: 1,
      repair: true,
      toolChoice: "required",
      models: ["deepseek-v4-pro", "gpt-oss-120b"],
    },
    {
      id: "auto",
      short: "auto",
      label: "tool_choice auto, сводка ×1",
      prompt: "real",
      digest: 1,
      toolChoice: "auto",
      when: "prod",
      stage: 2,
    },
    {
      id: "json",
      short: "JSON текстом",
      label: "JSON текстом без инструмента, сводка ×1",
      prompt: "json",
      digest: 1,
      when: "prod",
      stage: 2,
    },
  ],
};

/** The one-word question of the image variants without a tool (as the route probe asks critic_visual). */
export const SHAPE_SHORT = {
  system: "Это проверка связи платформы. Ответь одним словом.",
  user: "На картинках есть что-нибудь? Ответь: да или нет.",
};
/** Appended to the real system prompt in the JSON variants (followed by the tool's JSON Schema). */
export const SHAPE_JSON_RULE =
  "\n\nИнструментов в этом запросе нет. Ответь одним JSON-объектом — аргументами {tool} по JSON-схеме ниже, без пояснений и без markdown.\n";
/** Output tokens assumed for the expected ₽ (thinking included): a one-word answer, a tool call, JSON as text. */
export const SHAPE_OUTPUT_TOKENS = { short: 300, tool: 1500, json: 2500 };
/** Wall clock of the probe in the pod: no variant starts after it (the job has 90 minutes). */
export const SHAPE_MAX_SECONDS = 70 * 60;

export const SHAPE_IMAGES_FILE = new URL("./probe-shape-images.json", import.meta.url);
export const SHAPE_PROMPTS_FILE = new URL("./probe-shape-prompts.json", import.meta.url);

/** The committed request content: {images, prompts}. */
export function loadShapeFixture() {
  const images = JSON.parse(readFileSync(SHAPE_IMAGES_FILE, "utf8")).images.map((i) => ({
    name: i.name,
    mime: i.mime,
    data: i.data,
    px: i.px,
  }));
  const prompts = JSON.parse(readFileSync(SHAPE_PROMPTS_FILE, "utf8"));
  return { images, prompts };
}

/** `--shape critic,techreview` → the groups in probe order; "" → null (the route probe). */
export function parseShapeGroups(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const items = s.split(",").map((x) => x.trim());
  for (const x of items)
    if (!SHAPE_GROUPS.includes(x)) throw new Error(`--shape: ${SHAPE_GROUPS.join(", ")} через запятую`);
  return SHAPE_GROUPS.filter((g) => items.includes(g));
}

/**
 * The order of the probe: first every variant that always runs (the build shapes of every model, then the digest ×2
 * and the second turn), then the conditional ones stage by stage (cheap analysis, candidate fixes, costly analysis),
 * both groups in each stage — the cap cuts the least needed.
 */
export function shapePlan(groups = SHAPE_GROUPS) {
  const out = [];
  const add = (g, m, v) => {
    if (!v.models || v.models.includes(m))
      out.push({
        group: g,
        callType: SHAPE_CALL_TYPES[g],
        model: m,
        variant: v.id,
        ...(v.when ? { when: v.when } : {}),
      });
  };
  for (const g of groups)
    for (const v of SHAPE_VARIANTS[g].filter((x) => !x.when)) for (const m of SHAPE_CHAINS[g]) add(g, m, v);
  const stages = [...new Set(Object.values(SHAPE_VARIANTS).flatMap((vs) => vs.map((v) => v.stage ?? 0)))]
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  for (const s of stages)
    for (const g of groups)
      for (const m of SHAPE_CHAINS[g])
        for (const v of SHAPE_VARIANTS[g].filter((x) => x.when && x.stage === s)) add(g, m, v);
  return out;
}

/**
 * The request of a variant as the gateway gets it: {messages (LlmMessage), tool, toolChoice, kind}. `fx`: {images,
 * prompts, short, jsonRule}; `v` — the variant. Self-contained (the pod script embeds it).
 */
export function shapeMessages(fx, group, v) {
  const p = fx.prompts[group];
  const att = (n) =>
    fx.images.slice(0, n ?? 0).map((im) => ({ mime: im.mime, data: im.data, name: im.name }));
  const user = (content, n) => {
    const a = att(n);
    return a.length ? { role: "user", content, attachments: a } : { role: "user", content };
  };
  const kind = v.prompt === "short" ? "short" : v.prompt === "json" ? "json" : "tool";
  const system =
    kind === "short"
      ? fx.short.system
      : kind === "json"
        ? `${p.system}${fx.jsonRule.replace("{tool}", p.tool.name)}${JSON.stringify(p.tool.parameters)}`
        : p.system;
  const text =
    kind === "short" ? fx.short.user : group === "techreview" ? (v.digest === 2 ? p.user2 : p.user1) : p.user;
  const messages = [{ role: "system", content: system }, user(text, v.images)];
  if (v.repair) messages.push(p.repair.assistant, p.repair.tool);
  return {
    messages,
    tool: kind === "tool" ? p.tool : null,
    toolChoice: kind === "tool" ? v.toolChoice : null,
    kind,
  };
}

/**
 * Input tokens of a request for a model with `rule` (the image rule, models.yaml), as @wizard/llm estimateInputTokens
 * counts them: the JSON of the messages without the image bytes and of the tools, characters / 3.2, plus each image by
 * its size. `px` — the sizes of the attachments in order. Self-contained.
 */
export function shapeTokens(messages, tools, px, rule) {
  const r = rule ?? { px: 28, max: 16384 };
  const stripped = messages.map((m) =>
    m.role === "user" && m.attachments?.length
      ? { ...m, attachments: m.attachments.map((a) => ({ ...a, data: "" })) }
      : m,
  );
  const text =
    Math.ceil(JSON.stringify(stripped).length / 3.2) + Math.ceil(JSON.stringify(tools ?? []).length / 3.2);
  const images = px.reduce(
    (s, p) =>
      s +
      Math.min(
        r.max,
        Math.max(4, Math.ceil(Math.max(1, p.width) / r.px) * Math.ceil(Math.max(1, p.height) / r.px)),
      ) +
      2,
    0,
  );
  return text + images;
}

/** JSON object in a model's text (fenced or with a lead-in), null when none. Self-contained (the pod's fallback). */
export function looseJson(text) {
  const s = String(text ?? "").replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const variantOf = (group, id) => SHAPE_VARIANTS[group].find((v) => v.id === id);

/**
 * Expected ₽ of the shape probe by the prices and token estimates (images by the model's rule, the output by
 * SHAPE_OUTPUT_TOKENS): {base} — every build shape and the always-run variants answer; {worst} — every build shape is
 * refused (a refusal costs nothing) and every variant of analysis answers; {upper} — every variant at the route's
 * max_tokens. The cap holds the probe to it whatever happens.
 */
export function expectedShapeRub({ groups = SHAPE_GROUPS, fixture = loadShapeFixture() } = {}) {
  const fx = { ...fixture, short: SHAPE_SHORT, jsonRule: SHAPE_JSON_RULE };
  let base = 0;
  let worst = 0;
  let upper = 0;
  for (const it of shapePlan(groups)) {
    const v = variantOf(it.group, it.variant);
    const m = SHAPE_MODELS[it.model];
    const req = shapeMessages(fx, it.group, v);
    const input = shapeTokens(
      req.messages,
      req.tool ? [req.tool] : [],
      fx.images.slice(0, v.images ?? 0).map((i) => i.px),
      m.image,
    );
    const rub = (out) => (input * m.price.input + out * m.price.output) / 1e6;
    const exp = rub(SHAPE_OUTPUT_TOKENS[req.kind]);
    if (!it.when) base += exp;
    if (it.variant !== "prod") worst += exp;
    upper += rub(SHAPE_ROUTES[it.group].maxTokens);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { base: r2(base), worst: r2(worst), upper: r2(upper) };
}

/**
 * The shape probe in the pod. `cfg`: {orgId, capRub, plan, variants, routes?, images, prompts, short, jsonRule,
 * maxSeconds, fake, fakeFail}; `d`: {llm (the @wizard/llm namespace), postgres, env, providerCall, openAiBody,
 * shapeMessages, shapeTokens, looseJson, loadTools?, fetch?, log?}. Prints `shape=<json>` per variant and
 * `shape_total=<json>`; returns {results, total}. Self-contained: no reference to this module's scope.
 */
export async function shapeMain(cfg, d) {
  const log = d.log ?? ((s) => console.log(s));
  const llm = d.llm;
  const started = Date.now();
  const rows = [];
  let sql = null;
  // Usage of every attempt into platform.llm_calls of the probe's org (as the platform's DbUsageSink writes it).
  const sink = cfg.fake
    ? { write: (r) => void rows.push(r) }
    : {
        write: async (r) => {
          sql ??= d.postgres(d.env.WIZARD_DB_URL || d.env.DATABASE_URL, { max: 1, onnotice: () => {} });
          rows.push(r);
          await sql`insert into platform.llm_calls ${sql({
            id: r.id,
            org_id: r.orgId,
            system_id: r.systemId,
            run_id: r.runId,
            step: r.step,
            call_type: r.callType,
            agent_role: r.agentRole,
            tier: r.tier,
            provider: r.provider,
            model_id: r.modelId,
            attempt: r.attempt,
            status: r.status,
            error_code: r.errorCode,
            route_reason: r.routeReason,
            fallback_from: r.fallbackFrom,
            policy_version: r.policyVersion,
            scrubbed: r.scrubbed,
            pii_categories_count: sql.json(r.piiCategoriesCount ?? {}),
            input_tokens: r.inputTokens,
            cached_tokens: r.cachedTokens,
            output_tokens: r.outputTokens,
            tool_calls: r.toolCalls,
            latency_ms: Math.round(r.latencyMs),
            ttft_ms: r.ttftMs === null ? null : Math.round(r.ttftMs),
            cost_rub: r.costRub,
            credits_milli: r.creditsMilli,
            billable: r.billable,
            mode: r.mode,
            request_hash: r.requestHash,
            created_at: r.createdAt,
          })}`;
        },
      };
  // fake: providers answer in process — a tool call with valid arguments, JSON text when asked for it, «да» otherwise;
  // cfg.fakeFail [{model, minImages?, status?, message} | {model, text}] — a provider refusing matching requests, or a
  // model answering `text` instead of calling the tool (no network).
  const validArgs = (name) =>
    name === "submit_critique"
      ? {
          axes: { specificity: 3, first_screen: 3, typography: 3, color: 3, composition: 3, content: 3 },
          polish: "draft",
          findings: [],
        }
      : { findings: [] };
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const msgs = body.messages ?? [];
    const images = msgs
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === "image_url").length;
    const json = (status, value) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const rule = (cfg.fakeFail ?? []).find(
      (f) => String(body.model).includes(f.model) && images >= (f.minImages ?? 0),
    );
    if (rule && rule.text === undefined)
      return json(rule.status ?? 400, {
        error: { message: rule.message, type: "BadRequestError", code: rule.status ?? 400 },
      });
    const tool = rule ? undefined : body.tools?.[0]?.function?.name;
    const sys = String(msgs[0]?.content ?? "");
    const asked = sys.includes("submit_critique") ? "submit_critique" : "submit_techreview";
    const message = tool
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_fake",
              type: "function",
              function: { name: tool, arguments: JSON.stringify(validArgs(tool)) },
            },
          ],
        }
      : {
          role: "assistant",
          content: rule ? rule.text : sys.includes("JSON-объектом") ? JSON.stringify(validArgs(asked)) : "да",
        };
    return json(200, {
      id: "shape",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
    });
  };
  const fetchFn = cfg.fake ? fakeFetch : d.fetch;
  const env = cfg.fake
    ? { ...d.env, CLOUDRU_API_KEY: "probe-fake", ZAI_API_KEY: "probe-fake", YANDEX_API_KEY: "probe-fake" }
    : d.env;
  const secrets = Object.entries(env)
    .filter(([k, v]) => v && /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)/.test(k))
    .map(([, v]) => String(v));
  const base = llm.createRegistry({}, env);
  // The tools' own checks (normalize, zod, semantic) from @wizard/agents in the pod; without them — the schema's keys.
  let tools = null;
  let toolsNote = "проверка аргументов — @wizard/agents";
  try {
    tools = d.loadTools ? await d.loadTools() : null;
    if (!tools) toolsNote = "проверка аргументов — по обязательным ключам схемы";
  } catch (e) {
    toolsNote = `проверка аргументов — по обязательным ключам схемы (@wizard/agents: ${String(e?.message ?? e).slice(0, 120)})`;
  }
  const check = (group, args) => {
    const t = tools?.[group];
    if (t) {
      const p = t.parse(args);
      return p.ok
        ? { ok: true }
        : {
            ok: false,
            issues: (p.issues ?? [])
              .slice(0, 2)
              .map((i) => `${i.path || "—"}: ${i.code ?? ""} ${String(i.message ?? "").slice(0, 80)}`.trim()),
          };
    }
    const req = cfg.prompts[group].tool.parameters.required ?? [];
    const miss = args && typeof args === "object" ? req.filter((k) => !(k in args)) : req;
    return miss.length ? { ok: false, issues: [`нет ключей: ${miss.join(", ")}`] } : { ok: true };
  };
  const loose = (text) => {
    try {
      const v = tools?.looseObject ? tools.looseObject(text) : d.looseJson(text);
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  };
  const fx = { images: cfg.images, prompts: cfg.prompts, short: cfg.short, jsonRule: cfg.jsonRule };
  const results = [];
  const byKey = new Map();
  let spent = 0;
  let unrecorded = 0;
  let stopped = null;
  const round = (x, n = 10000) => Math.round(x * n) / n;
  for (const it of cfg.plan) {
    const v = cfg.variants[it.group].find((x) => x.id === it.variant);
    const key = (id) => `${it.group}:${it.model}:${id}`;
    const r = {
      group: it.group,
      callType: it.callType,
      model: it.model,
      variant: it.variant,
      label: v.short,
    };
    const skip = (reason, unneeded = false) => {
      Object.assign(r, { status: "skipped", verdict: unneeded ? "unneeded" : "skipped", reason });
      results.push(r);
      byKey.set(key(it.variant), r);
      log(`shape=${JSON.stringify(r)}`);
    };
    if (it.when) {
      const prev = byKey.get(key(it.when));
      if (!prev || prev.status === "skipped" || prev.verdict === "ok") {
        skip(
          `не нужен: «${prev?.label ?? it.when}» ${prev?.verdict === "ok" ? "прошёл" : "не запускался"}`,
          true,
        );
        continue;
      }
    }
    if ((Date.now() - started) / 1000 > (cfg.maxSeconds ?? 4200)) {
      stopped ??= `время пробы ${Math.round((cfg.maxSeconds ?? 4200) / 60)} мин вышло`;
      skip(stopped);
      continue;
    }
    const model = base.models.find((m) => m.id === it.model);
    const route0 = base.routes[it.callType];
    if (!model?.enabled || !route0) {
      skip("модели или маршрута нет в реестре сервера");
      continue;
    }
    const req = d.shapeMessages(fx, it.group, v);
    const toolsOf = req.tool ? [req.tool] : undefined;
    const px = cfg.images.slice(0, v.images ?? 0).map((i) => i.px);
    const input = d.shapeTokens(req.messages, toolsOf ?? [], px, model.image);
    const upper = (input * model.price.input + route0.maxTokens * model.price.output) / 1e6;
    if (spent >= cfg.capRub || spent + upper > cfg.capRub) {
      stopped ??= `потолок пробы ${cfg.capRub} ₽: потрачено ≈ ${round(spent, 100)} ₽, следующему вызову нужно до ${round(upper, 100)} ₽`;
      skip(stopped);
      continue;
    }
    // The route of the call type with the one model under test (its own limits and timeout), T0 by default.
    const route = { ...route0, defaultTier: "T0", chain: { T0: [it.model] } };
    const reg = { ...base, routes: { ...base.routes, [it.callType]: route } };
    const router = llm.createRouter({
      mode: "live",
      registry: reg,
      sink,
      env,
      circuit: new llm.CircuitBreaker(),
      ...(fetchFn ? { fetch: fetchFn } : {}),
      ...(cfg.fake ? { sleep: async () => {} } : {}),
    });
    const before = rows.length;
    const t0 = Date.now();
    try {
      const res = await router.route({
        callType: it.callType,
        messages: req.messages,
        ...(toolsOf ? { tools: toolsOf, toolChoice: req.toolChoice } : {}),
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx: { orgId: cfg.orgId, step: `v3_shape:${it.callType}:${it.variant}` },
        // One full attempt at most: a timeout is not repeated for minutes.
        signal: AbortSignal.timeout(route.timeoutMs + 15_000),
      });
      const text = String(res.result.text ?? "");
      const calls = res.result.toolCalls ?? [];
      Object.assign(r, {
        status: "ok",
        served: res.model,
        finishReason: res.result.finishReason,
        toolCalls: calls.length,
        answerChars: text.length,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
      });
      if (req.kind === "tool") {
        const mine = calls.find((c) => c.name === req.tool.name);
        if (mine) {
          const c = check(it.group, mine.args);
          r.verdict = c.ok ? "ok" : "invalid";
          if (!c.ok) r.issues = c.issues;
        } else {
          r.verdict = "no_tool";
          const j = text ? loose(text) : null;
          if (j) r.textJson = check(it.group, j).ok ? "годится" : "не проходит проверку";
          // The start of the model's answer to synthetic content: why it did not call the tool.
          r.answerHead = text.replace(/\s+/g, " ").slice(0, 100);
        }
      } else if (req.kind === "json") {
        const j = loose(text);
        if (!j) {
          r.verdict = "no_json";
          r.answerHead = text.replace(/\s+/g, " ").slice(0, 100);
        } else {
          const c = check(it.group, j);
          r.verdict = c.ok ? "ok" : "invalid";
          if (!c.ok) r.issues = c.issues;
        }
      } else r.verdict = text.trim() ? "ok" : "empty";
    } catch (e) {
      Object.assign(r, {
        status: "error",
        verdict: "error",
        code: e?.code ?? e?.name ?? "ERROR",
        message: String(e?.message ?? e)
          .replace(/\s+/g, " ")
          .slice(0, 160),
      });
    }
    const attempts = rows.slice(before);
    const rub = attempts.reduce((s, x) => s + Number(x.costRub ?? 0), 0);
    // NETWORK / EMPTY_RESPONSE may still be an answer the provider billed while the journal has 0 ₽ for it (a broken
    // connection after the answer; before the gateway fix — a text answer under toolChoice required): the cap counts an
    // estimate of each such attempt — by the expected answer, then by the direct call's real usage.
    const unbilled = attempts.filter((x) => ["NETWORK", "EMPTY_RESPONSE"].includes(x.errorCode)).length;
    let guess =
      (unbilled * (input * model.price.input + (cfg.outputTokens?.[req.kind] ?? 1500) * model.price.output)) /
      1e6;
    spent += rub + guess;
    Object.assign(r, {
      latencyMs: Date.now() - t0,
      attempts: attempts.length,
      rub: round(rub),
      tried: attempts.map((x) => `${x.modelId}:${x.status}${x.errorCode ? `:${x.errorCode}` : ""}`),
    });
    // A failed variant: the same request once more, straight to the provider, for its own words.
    if (r.status === "error") {
      const last = attempts.at(-1)?.errorCode ?? null;
      const provider = reg.providers[model.provider];
      if (!attempts.length)
        r.diag = {
          skipped: `попыток не было (${r.code}: нет ключа провайдера в поде, модель выключена или тип вызова неизвестен серверу)`,
        };
      else if (["TIMEOUT", "ABORTED", "MODEL_NOT_ALLOWED"].includes(last))
        r.diag = { skipped: last === "TIMEOUT" ? "тайм-аут — повтор не даст текста ошибки" : `код ${last}` };
      else if (spent + upper > cfg.capRub) r.diag = { skipped: "не хватит потолка пробы" };
      else {
        const url = `${String(llm.providerBaseUrl ? llm.providerBaseUrl(provider, env) : env[provider.baseUrlEnv] || provider.defaultBaseUrl).replace(/\/+$/, "")}/chat/completions`;
        const folder = provider.folderEnv ? env[provider.folderEnv] : undefined;
        let body = d.openAiBody({
          model: folder ? `gpt://${folder}/${model.providerModel}` : model.providerModel,
          messages: req.messages,
          tools: toolsOf,
          toolChoice: req.toolChoice,
          temperature: route.temperature,
          maxTokens: route.maxTokens,
        });
        if (llm.transformBody) body = llm.transformBody(provider.id, body, "low");
        const res = await d.providerCall({
          url,
          key: env[provider.apiKeyEnv] ?? "",
          headers: provider.requiredHeaders ?? {},
          body,
          timeoutMs: route.timeoutMs,
          secrets,
          ...(fetchFn ? { fetch: fetchFn } : {}),
        });
        const u = res.json?.usage ?? {};
        const usage = {
          inputTokens: Number(u.prompt_tokens ?? 0),
          cachedTokens: Math.min(
            Number(u.prompt_tokens_details?.cached_tokens ?? 0),
            Number(u.prompt_tokens ?? 0),
          ),
          outputTokens: Number(u.completion_tokens ?? 0),
        };
        const cost = res.ok
          ? Math.round(
              (((usage.inputTokens - usage.cachedTokens) * model.price.input +
                usage.cachedTokens * model.price.cached +
                usage.outputTokens * model.price.output) /
                1e6) *
                1e4,
            ) / 1e4
          : 0;
        await sink.write({
          id: globalThis.crypto.randomUUID(),
          runId: null,
          orgId: cfg.orgId,
          systemId: null,
          step: `v3_shape:${it.callType}:${it.variant}:diag`,
          callType: it.callType,
          agentRole: route.role,
          tier: model.tier,
          provider: model.provider,
          modelId: model.id,
          attempt: 1,
          status: res.ok ? "ok" : res.timeout ? "timeout" : "error",
          errorCode: res.ok ? null : res.status ? `HTTP_${res.status}` : res.timeout ? "TIMEOUT" : "NETWORK",
          routeReason: "default_T0",
          fallbackFrom: null,
          policyVersion: llm.policyVersion ? llm.policyVersion(reg) : "v3-shape",
          scrubbed: model.tier === "T1",
          piiCategoriesCount: {},
          ...usage,
          toolCalls: res.json?.choices?.[0]?.message?.tool_calls?.length ?? 0,
          latencyMs: res.ms,
          ttftMs: null,
          costRub: cost,
          creditsMilli: res.ok ? Math.ceil(Math.round(((cost * 1000) / reg.rubPerCredit) * 1e6) / 1e6) : 0,
          billable: res.ok,
          mode: "live",
          requestHash: null,
          createdAt: new Date().toISOString(),
        });
        spent += cost;
        r.diag = res.status
          ? { http: res.status, ms: res.ms, note: res.note, rub: cost }
          : { error: res.error, ms: res.ms };
        // The same request answered directly: each refused attempt cost about as much; refused directly — nothing.
        if (unbilled && res.status) {
          const real = res.ok ? unbilled * cost : 0;
          spent += real - guess;
          guess = real;
        }
      }
    }
    unrecorded += guess;
    if (guess) r.unrecordedRub = round(guess, 100);
    results.push(r);
    byKey.set(key(it.variant), r);
    log(`shape=${JSON.stringify(r)}`);
  }
  const total = {
    spentRub: round(spent - unrecorded),
    unrecordedRub: round(unrecorded, 100),
    capRub: cfg.capRub,
    stopped,
    seconds: Math.round((Date.now() - started) / 1000),
    fake: !!cfg.fake,
    checks: toolsNote,
  };
  log(`shape_total=${JSON.stringify(total)}`);
  await sql?.end({ timeout: 5 }).catch(() => {});
  return { results, total };
}

/**
 * The pod's loader of the tools' own checks: the @wizard/agents sources next to the worker (the image keeps the repo
 * layout). Source text, not a function: a test runner rewrites the imports of the functions it loads.
 */
export const POD_TOOLS_SOURCE = `async () => {
  const base = pathToFileURL(process.cwd() + "/");
  const at = (p) => new URL("../../packages/agents/src/" + p, base).href;
  const [critic, review, loose] = await Promise.all([
    import(at("builder/v3/critic/prompt.ts")),
    import(at("builder/v3/techreview/reviewer.ts")),
    import(at("core/loose-json.ts")),
  ]);
  return { critic: critic.critiqueTool, techreview: review.submitTechreview, looseObject: loose.looseObject };
}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The settings the pod gets: the plan, the variants and the request content. */
export function shapeConfig({
  orgId,
  capRub,
  groups = SHAPE_GROUPS,
  fake = false,
  fakeFail = [],
  maxSeconds = SHAPE_MAX_SECONDS,
  fixture = loadShapeFixture(),
}) {
  if (!UUID.test(String(orgId))) throw new Error("проба формы: нужен id организации пробы");
  if (!Number.isFinite(capRub) || capRub <= 0 || capRub > PROBE_MAX_CAP_RUB)
    throw new Error(`проба формы: потолок от 1 до ${PROBE_MAX_CAP_RUB} ₽`);
  if (!groups.length || groups.some((g) => !SHAPE_GROUPS.includes(g)))
    throw new Error(`проба формы: группы — ${SHAPE_GROUPS.join(", ")}`);
  return {
    orgId,
    capRub,
    plan: shapePlan(groups),
    variants: SHAPE_VARIANTS,
    images: fixture.images,
    prompts: fixture.prompts,
    short: SHAPE_SHORT,
    jsonRule: SHAPE_JSON_RULE,
    outputTokens: SHAPE_OUTPUT_TOKENS,
    maxSeconds,
    fake,
    fakeFail,
  };
}

/**
 * The ES module the pod runs from stdin (`node --import tsx --input-type=module -`, cwd = the worker's app folder):
 * the @wizard/llm namespace of the worker image (an older release lacking an optional export still runs), postgres,
 * the self-contained functions of this module and of provider-call.mjs, the settings as a JSON literal — the org id
 * is not secret, no key or address is in the script.
 */
export function shapeScript(opts) {
  const cfg = shapeConfig(opts);
  return [
    'import * as llm from "@wizard/llm";',
    'import postgres from "postgres";',
    'import { pathToFileURL } from "node:url";',
    `const providerCall = ${providerCall.toString()};`,
    `const openAiBody = ${openAiBody.toString()};`,
    `const shapeMessages = ${shapeMessages.toString()};`,
    `const shapeTokens = ${shapeTokens.toString()};`,
    `const looseJson = ${looseJson.toString()};`,
    `const podTools = ${POD_TOOLS_SOURCE};`,
    `const shapeMain = ${shapeMain.toString()};`,
    `await shapeMain(${JSON.stringify(cfg)}, { llm, postgres, env: process.env, providerCall, openAiBody, shapeMessages, shapeTokens, looseJson, loadTools: podTools });`,
    "",
  ].join("\n");
}

/** `shape=` and `shape_total=` lines of the pod's output → {results, total}; other lines are ignored. */
export function parseShapeOutput(stdout) {
  const results = [];
  let total = null;
  for (const line of String(stdout ?? "").split("\n")) {
    const l = line.trim();
    try {
      if (l.startsWith("shape=")) results.push(JSON.parse(l.slice("shape=".length)));
      else if (l.startsWith("shape_total=")) total = JSON.parse(l.slice("shape_total=".length));
    } catch {}
  }
  return { results, total };
}

const rubText = (n) => `${(Math.round(n * 100) / 100).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;
const sec = (ms) => `${(Math.round((ms ?? 0) / 100) / 10).toLocaleString("ru-RU")} с`;
const one = (s) =>
  String(s ?? "")
    .replace(/[\r\n|]+/g, " ")
    .trim();

/** The provider's own words of a failed variant: «HTTP 400 «…»» | the network error | why there was no repeat. */
function diagText(diag, max) {
  if (!diag) return "";
  if (diag.skipped) return `без прямого вызова: ${diag.skipped}`;
  if (diag.http) return `напрямую HTTP ${diag.http}${diag.note ? ` «${one(diag.note).slice(0, max)}»` : ""}`;
  return `напрямую: ${one(diag.error).slice(0, max)}`;
}

/** One variant in a few words (annotations and the report). */
export function shapeOutcome(r, max = 160) {
  const head = r.answerHead ? ` «${one(r.answerHead).slice(0, Math.min(max, 100))}»` : "";
  const extra = r.unrecordedRub ? `, ≈ ${rubText(r.unrecordedRub)} вне журнала` : "";
  switch (r.verdict) {
    case "ok":
      return `✅ ${sec(r.latencyMs)}, ${rubText(r.rub ?? 0)}`;
    case "no_tool":
      return `⚠️ без вызова инструмента (finish ${r.finishReason ?? "—"}, текст ${r.answerChars ?? 0} зн.${r.textJson ? `, JSON в тексте ${r.textJson}` : ""})${head}, ${sec(r.latencyMs)}`;
    case "invalid":
      return `⚠️ аргументы не прошли проверку: ${one((r.issues ?? []).join("; ")).slice(0, max)}`;
    case "no_json":
      return `⚠️ в ответе нет JSON (текст ${r.answerChars ?? 0} зн., finish ${r.finishReason ?? "—"})${head}`;
    case "empty":
      return "⚠️ пустой ответ";
    case "error":
      return `❌ ${r.code ?? "ошибка"} [${triedText(r.tried)}], ${sec(r.latencyMs)}${extra}${r.diag ? ` → ${diagText(r.diag, max)}` : ""}`;
    default:
      return `⏭ ${r.reason ?? "пропущен"}`;
  }
}

/** Attempts of a variant, repeats folded: «m:error:NETWORK ×3». */
export function triedText(tried) {
  const out = [];
  for (const t of tried ?? []) {
    const last = out.at(-1);
    if (last?.t === t) last.n += 1;
    else out.push({ t, n: 1 });
  }
  return out.map((x) => (x.n > 1 ? `${x.t} ×${x.n}` : x.t)).join(", ") || "—";
}

/** (callType, model) pairs in the order of the results. */
function byModel(results) {
  const out = new Map();
  for (const r of results) {
    const k = `${r.callType} · ${r.model}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/**
 * Workflow annotations: one line per call type and model (GitHub shows at most 10 annotations of a kind per step),
 * the variants in it — a notice when the build shape works, a warning otherwise. A provider text repeated within the
 * line is written once. Variants not needed (the build shape worked) are left out.
 */
export function shapeAnnotations(results) {
  const out = [];
  for (const [k, rs] of byModel(results)) {
    const prod = rs.find((r) => r.variant === "prod");
    const seen = new Set();
    const parts = rs
      .filter((r) => r.verdict !== "unneeded")
      .map((r) => {
        let o = shapeOutcome(r, 160);
        const note = r.diag?.note ?? r.diag?.error;
        if (note) {
          const t = one(note).slice(0, 160);
          if (seen.has(t)) o = o.replace(`«${t}»`, "«то же»");
          seen.add(t);
        }
        return `${r.label}: ${o}`;
      });
    out.push(
      `::${prod?.verdict === "ok" ? "notice" : "warning"} title=V3 форма · ${k}::${parts.join(" · ").replace(/[\r\n]+/g, " ")}`,
    );
  }
  return out;
}

/** {total, ready, passed, costRub, prodOk, prodTotal} of the spend journal: passed — every build shape worked. */
export function shapeSummary({ results, total }) {
  const ran = results.filter((r) => r.status !== "skipped");
  const prod = results.filter((r) => r.variant === "prod");
  const prodOk = prod.filter((r) => r.verdict === "ok").length;
  return {
    total: ran.length,
    ready: ran.filter((r) => r.verdict === "ok").length,
    passed: prod.length > 0 && prodOk === prod.length,
    costRub: Math.round(Number(total?.spentRub ?? ran.reduce((s, r) => s + (r.rub ?? 0), 0)) * 100) / 100,
    costExact: !total?.fake,
    prodOk,
    prodTotal: prod.length,
  };
}

/** The shape probe report (Russian Markdown) and its summary for the spend journal. */
export function renderShapeReport({ results, total }, meta = {}) {
  const summary = shapeSummary({ results, total });
  const L = [
    `# Проба формы запросов v3 — ${meta.date ?? ""}`.trim(),
    "",
    `Платформа: ${meta.platform ?? "—"} · формы запросов как в сборке на синтетике, каждая модель цепочки отдельно, через шлюз сервера · потолок ${rubText(total?.capRub ?? 0)}${total?.fake ? " · **без сети (fake)**" : ""}`,
    "",
    `**Итог: как в сборке прошли ${summary.prodOk} из ${summary.prodTotal} моделей; вариантов годны ${summary.ready} из ${summary.total}; расход ${rubText(summary.costRub)}${total?.unrecordedRub ? ` (+ ≈ ${rubText(total.unrecordedRub)} вне журнала)` : ""}${total?.stopped ? `; остановлена: ${total.stopped}` : ""}.**`,
    "",
    `Варианты: ${Object.entries(SHAPE_VARIANTS)
      .map(([g, vs]) => `${SHAPE_CALL_TYPES[g]} — ${vs.map((v) => `«${v.short}» (${v.label})`).join(", ")}`)
      .join(
        "; ",
      )}. Варианты разбора идут, только если «как в сборке» не годится. ${total?.checks ? `Аргументы: ${total.checks.replace(/^проверка аргументов — /, "")}.` : ""}`,
    "",
  ];
  for (const [k, rs] of byModel(results)) {
    L.push(
      `## ${k}`,
      "",
      "| Вариант | Итог | Ответила | Попытки | Токены вход/выход | Прямой вызов провайдера |",
      "|---|---|---|---|---|---|",
    );
    for (const r of rs) {
      if (r.verdict === "unneeded") continue;
      L.push(
        `| ${one(r.label)} | ${one(shapeOutcome({ ...r, diag: null }, 300))} | ${one(r.served ?? "—")} | ${one(triedText(r.tried))} | ${r.inputTokens ?? "—"}/${r.outputTokens ?? "—"} | ${one(diagText(r.diag, 300)) || "—"} |`,
      );
    }
    L.push("");
  }
  L.push(...(meta.notes ?? []).map((n) => `- ${n}`), "");
  return { text: L.join("\n"), summary };
}
