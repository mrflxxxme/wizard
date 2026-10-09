// V3-18: the probe of the v3 model routes (step 2 of the lean dev harness, agents/builder-v3.md §4: ≤ 30 ₽, pre-registered
// in the spend journal like eval; docs/plans/2026-10-08-v3.md §4): one minimal real call per v3 callType route head —
// interview_v3, brief_extract, art_direction, page_compose, signature_section, critic_visual (one small image), techreview,
// research (only when the server's research is live) — through the server's own gateway: @wizard/llm createRouter with the
// worker pod's keys, registry and policy, usage written to platform.llm_calls of an eval org (the v3 budget and the eval
// daily cap count it). Per call: status, the model actually served, tier and route reason, scrub, latency, ₽. The probe
// stops at its cap: no call starts once the spend reached it.
//
// The code that runs in the pod is probeMain (self-contained: it gets every dependency as an argument), shipped over
// stdin by probeScript — `kubectl exec -i deploy/wizard-worker -- node --import tsx --input-type=module -` in the app
// folder of the worker image, so it needs no file of this release on the server. `fake: true` answers every call
// in process (no network, no database, no money): the CI test runs the very script of the pod that way.

/** Call types of the v3 pipeline (agents/builder-v3.md C7, models.yaml#call_types) in the order of the probe. */
export const PROBE_CALL_TYPES = [
  "interview_v3",
  "brief_extract",
  "art_direction",
  "page_compose",
  "signature_section",
  "critic_visual",
  "techreview",
  "research",
];
/** Step 2 of the ladder: a probe never costs more than this (D77 (18б), docs/plans/2026-10-08-v3.md §4). */
export const PROBE_MAX_CAP_RUB = 30;
/**
 * Route heads of the probe and their prices, ₽ per 1M tokens with VAT (specs/agents/models.yaml; a test keeps them equal
 * to the registry). The head a call reaches on the server may differ (WIZARD_BUILD_DEFAULT_TIER=T0, an empty balance):
 * the probe reports the model actually served.
 */
export const PROBE_HEADS = {
  interview_v3: { model: "glm-5.3", tier: "T1", price: { input: 162, output: 510 } },
  brief_extract: { model: "gigachat-3.5", tier: "T0", price: { input: 96.22, output: 288.6 } },
  art_direction: { model: "glm-5.3", tier: "T1", price: { input: 162, output: 510 } },
  page_compose: { model: "glm-5.3", tier: "T1", price: { input: 162, output: 510 } },
  signature_section: { model: "glm-5.3", tier: "T1", price: { input: 162, output: 510 } },
  // A call with an image goes to T0 (llm policy: attachments → T0): the vision head of the T0 chain.
  critic_visual: { model: "kimi-k2.6", tier: "T0", price: { input: 175.68, output: 725.9 } },
  techreview: { model: "deepseek-v4-pro", tier: "T0", price: { input: 183, output: 732 } },
  research: { model: "gpt-oss-120b", tier: "T0", price: { input: 15.86, output: 61 } },
};
/**
 * Tokens of one probe call for the expected ₽: a short system line and a one-word question, a short answer; Z.ai models
 * always think (reasoning_effort low) — their answer is counted as 1 000 tokens.
 */
export const PROBE_TOKENS = { input: 300, output: 150, thinking: 1000 };

/** Expected ₽ of one probe call by its head (input + output tokens at the head's price). */
export function expectedCallRub(callType) {
  const h = PROBE_HEADS[callType];
  if (!h) return 0;
  const out = h.tier === "T1" ? PROBE_TOKENS.thinking : PROBE_TOKENS.output;
  return Math.round(((PROBE_TOKENS.input * h.price.input + out * h.price.output) / 1e6) * 1000) / 1000;
}

/** Expected ₽ of the whole probe (research only when the server's research is live). */
export function expectedProbeRub({ research = true } = {}) {
  const types = PROBE_CALL_TYPES.filter((t) => research || t !== "research");
  return Math.round(types.reduce((s, t) => s + expectedCallRub(t), 0) * 100) / 100;
}

/** An 8×8 white PNG (the critic_visual call needs one small image; no content of any system). */
export const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR42mP4jwMwDC0JALoev0GJ6La7AAAAAElFTkSuQmCC";

/**
 * The probe in the pod. `cfg`: {orgId, capRub, callTypes, png, fake}; `d`: {createRouter, createRegistry,
 * CircuitBreaker, postgres, env, log}. Prints one line `probe=<json>` per call and `probe_total=<json>` at the end;
 * returns the results. Self-contained: no reference to this module's scope (probeScript ships its source).
 */
export async function probeMain(cfg, d) {
  const log = d.log ?? ((s) => console.log(s));
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
  // fake: every provider answers «да» in process (OpenAI chat.completion shape), the keys are dummies.
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({
        id: "probe",
        object: "chat.completion",
        created: 1,
        model: body.model ?? "fake",
        choices: [{ index: 0, message: { role: "assistant", content: "да" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 2, total_tokens: 302 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const env = cfg.fake
    ? { ...d.env, CLOUDRU_API_KEY: "probe-fake", ZAI_API_KEY: "probe-fake", YANDEX_API_KEY: "probe-fake" }
    : d.env;
  const router = d.createRouter({
    mode: "live",
    registry: d.createRegistry({}, env),
    sink,
    env,
    circuit: new d.CircuitBreaker(),
    ...(cfg.fake ? { fetch: fakeFetch } : {}),
  });
  const researchLive =
    String(d.env.WIZARD_RESEARCH_MODE ?? "")
      .trim()
      .toLowerCase() === "live";
  const out = [];
  let spent = 0;
  let stopped = null;
  for (const callType of cfg.callTypes) {
    const base = { callType };
    if (callType === "research" && !researchLive && !cfg.fake) {
      const r = {
        ...base,
        status: "skipped",
        reason: "исследование на сервере выключено (WIZARD_RESEARCH_MODE не live)",
      };
      out.push(r);
      log(`probe=${JSON.stringify(r)}`);
      continue;
    }
    if (spent >= cfg.capRub) {
      stopped ??= `потолок пробы ${cfg.capRub} ₽ достигнут (≈ ${Math.round(spent * 100) / 100} ₽)`;
      const r = { ...base, status: "skipped", reason: stopped };
      out.push(r);
      log(`probe=${JSON.stringify(r)}`);
      continue;
    }
    const before = rows.length;
    const t0 = Date.now();
    let r;
    try {
      const res = await router.route({
        callType,
        messages: [
          { role: "system", content: "Это проверка связи платформы. Ответь одним словом." },
          {
            role: "user",
            content:
              callType === "critic_visual" ? "На картинке есть что-нибудь? Ответь: да или нет." : "Скажи: да",
            ...(callType === "critic_visual" && cfg.png
              ? { attachments: [{ mime: "image/png", data: cfg.png, name: "probe.png" }] }
              : {}),
          },
        ],
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx: { orgId: cfg.orgId, step: `v3_probe:${callType}` },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000),
      });
      r = {
        ...base,
        status: "ok",
        model: res.model,
        tier: res.tier,
        routeReason: res.routeReason,
        scrubbed: res.scrubbed,
        ruFallback: res.ruFallback,
        finishReason: res.result.finishReason,
        answerChars: String(res.result.text ?? "").length,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
      };
    } catch (e) {
      r = {
        ...base,
        status: "error",
        code: e?.code ?? e?.name ?? "ERROR",
        message: String(e?.message ?? e)
          .replace(/\s+/g, " ")
          .slice(0, 200),
      };
    }
    const attempts = rows.slice(before);
    const rub = attempts.reduce((s, x) => s + Number(x.costRub ?? 0), 0);
    spent += rub;
    Object.assign(r, {
      latencyMs: Date.now() - t0,
      attempts: attempts.length,
      rub: Math.round(rub * 10000) / 10000,
      tried: attempts.map((x) => `${x.modelId}:${x.status}`),
    });
    out.push(r);
    log(`probe=${JSON.stringify(r)}`);
  }
  const total = {
    spentRub: Math.round(spent * 10000) / 10000,
    capRub: cfg.capRub,
    stopped,
    seconds: Math.round((Date.now() - started) / 1000),
    fake: !!cfg.fake,
  };
  log(`probe_total=${JSON.stringify(total)}`);
  await sql?.end({ timeout: 5 }).catch(() => {});
  return { calls: out, total };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The ES module the pod runs from stdin (`node --import tsx --input-type=module -`, cwd = the worker's app folder):
 * imports of the worker image (@wizard/llm, postgres) and probeMain with the probe's settings as a JSON literal — the
 * org id is not secret, no key or address is in the script.
 */
export function probeScript({
  orgId,
  capRub,
  callTypes = PROBE_CALL_TYPES,
  fake = false,
  timeoutMs = 120_000,
}) {
  if (!UUID.test(String(orgId))) throw new Error("проба: нужен id организации пробы");
  if (!Number.isFinite(capRub) || capRub <= 0 || capRub > PROBE_MAX_CAP_RUB)
    throw new Error(`проба: потолок от 1 до ${PROBE_MAX_CAP_RUB} ₽`);
  for (const t of callTypes)
    if (!PROBE_CALL_TYPES.includes(t)) throw new Error(`проба: неизвестный тип вызова ${t}`);
  const cfg = { orgId, capRub, callTypes, png: PROBE_PNG_BASE64, fake, timeoutMs };
  return [
    'import { CircuitBreaker, createRegistry, createRouter } from "@wizard/llm";',
    'import postgres from "postgres";',
    `const probeMain = ${probeMain.toString()};`,
    `await probeMain(${JSON.stringify(cfg)}, { createRouter, createRegistry, CircuitBreaker, postgres, env: process.env });`,
    "",
  ].join("\n");
}

/**
 * psql script (stdin, as seed.mjs): the exact ₽ of the probe's org from platform.llm_calls (billable attempts) — one
 * line `probe_rub=<₽>`. The org id reaches psql as a validated \set literal.
 */
export function probeSpendSql({ orgId }) {
  if (!UUID.test(String(orgId))) throw new Error("проба: нужен id организации пробы");
  return [
    `\\set org_id '${orgId}'`,
    `SELECT 'probe_rub=' || coalesce(round(sum(c.cost_rub), 4), 0)::text FROM platform.llm_calls c
   WHERE c.org_id = :'org_id' AND c.billable;`,
    "",
  ].join("\n");
}

/** `probe=` and `probe_total=` lines of the pod's output → {calls, total}; other lines are ignored. */
export function parseProbeOutput(stdout) {
  const calls = [];
  let total = null;
  for (const line of String(stdout ?? "").split("\n")) {
    const l = line.trim();
    try {
      if (l.startsWith("probe=")) calls.push(JSON.parse(l.slice("probe=".length)));
      else if (l.startsWith("probe_total=")) total = JSON.parse(l.slice("probe_total=".length));
    } catch {}
  }
  return { calls, total };
}

const rub = (n) => `${(Math.round(n * 100) / 100).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;
const cell = (s) =>
  String(s ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
const STATUS_RU = { ok: "✅ ответила", error: "❌ ошибка", skipped: "⏭ пропущен" };

/**
 * One workflow annotation per probed route (the report itself stays in the artifact and the step summary, which the
 * GitHub API does not serve): notice for an answer, warning for an error or a skip; numbers and names only.
 */
export function probeAnnotations(calls) {
  return calls.map((c) => {
    const level = c.status === "ok" ? "notice" : "warning";
    const parts =
      c.status === "ok"
        ? [
            `ответила ${c.model ?? "—"} (${c.tier ?? "—"}, ${c.routeReason ?? "—"})`,
            `маскирование ПДн: ${c.scrubbed ? "да" : "нет"}`,
            `${c.latencyMs ?? "—"} мс`,
            `${c.rub === undefined ? "—" : rub(c.rub)}`,
            `попытки: ${(c.tried ?? []).join(", ") || "—"}`,
          ]
        : c.status === "skipped"
          ? [`пропущен: ${c.reason ?? "—"}`]
          : [`ошибка ${c.code ?? "—"}: ${String(c.message ?? "").slice(0, 160)}`, `попытки: ${(c.tried ?? []).join(", ") || "—"}`];
    return `::${level} title=V3 проба · ${c.callType}::${parts.join(" · ").replace(/[\r\n]+/g, " ")}`;
  });
}

/** The probe report (Russian Markdown) and its summary {total, ok, costRub, passed} for the spend journal. */
export function renderProbeReport({ calls, total }, meta = {}) {
  const ok = calls.filter((c) => c.status === "ok").length;
  const ran = calls.filter((c) => c.status !== "skipped").length;
  const costRub = Math.round(calls.reduce((s, c) => s + (c.rub ?? 0), 0) * 100) / 100;
  const L = [
    `# Проба маршрутов v3 — ${meta.date ?? ""}`.trim(),
    "",
    `Платформа: ${meta.platform ?? "—"} · по одному минимальному вызову на голову маршрута через шлюз сервера · потолок ${rub(total?.capRub ?? 0)}${total?.fake ? " · **без сети (fake)**" : ""}`,
    "",
    `**Итог: ответили ${ok} из ${ran}${calls.length > ran ? ` (пропущено ${calls.length - ran})` : ""}; расход ${rub(costRub)}${total?.stopped ? `; остановлена: ${total.stopped}` : ""}.**`,
    "",
    "| Тип вызова | Голова по маршруту | Статус | Ответила модель | Уровень | Причина маршрута | Маскирование ПДн | мс | ₽ | Попытки |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of calls) {
    const head = PROBE_HEADS[c.callType];
    L.push(
      `| ${cell(c.callType)} | ${cell(head ? `${head.model} (${head.tier})` : "—")} | ${STATUS_RU[c.status] ?? c.status} | ${cell(c.model ?? "—")} | ${cell(c.tier ?? "—")} | ${cell(c.routeReason ?? "—")} | ${c.status === "ok" ? (c.scrubbed ? "да" : "нет") : "—"} | ${c.latencyMs ?? "—"} | ${c.rub === undefined ? "—" : rub(c.rub)} | ${cell((c.tried ?? []).join(", ") || "—")} |`,
    );
  }
  const problems = calls.filter((c) => c.status === "error");
  if (problems.length)
    L.push("", "## Ошибки", "", ...problems.map((c) => `- ${c.callType}: ${c.code} — ${c.message}`));
  const skipped = calls.filter((c) => c.status === "skipped");
  if (skipped.length) L.push("", "## Пропущено", "", ...skipped.map((c) => `- ${c.callType}: ${c.reason}`));
  const heads = calls.filter(
    (c) => c.status === "ok" && PROBE_HEADS[c.callType] && c.model !== PROBE_HEADS[c.callType].model,
  );
  if (heads.length)
    L.push(
      "",
      "## Ответила не голова маршрута",
      "",
      ...heads.map(
        (c) =>
          `- ${c.callType}: ответила ${c.model} (${c.tier}, ${c.routeReason}) вместо ${PROBE_HEADS[c.callType].model}`,
      ),
    );
  L.push("", ...(meta.notes ?? []).map((n) => `- ${n}`), "");
  return {
    text: L.join("\n"),
    summary: { total: ran, ready: ok, passed: ran > 0 && ok === ran, costRub, costExact: !total?.fake },
  };
}
