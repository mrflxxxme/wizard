// V3-18: the v3 measurement driver (checkpoint 1 of wave A, product.yaml#decisions.D77_v3 (8)–(11), (16);
// docs/plans/2026-10-08-v3.md §4–5): a v3 brief goes through the real v3 path of the pilot server the way an owner does
// it in the cabinet — createSystem in the eval org (its org is on v3: WIZARD_BUILD_PIPELINE_ORGS) → the grill interview
// answered from the brief (a topic's option stem, «Решите за меня», an own text; else the recommended option; «Дальше
// решай сам» after rest_after answers) → optionally the ТЗ file → three directions and the pick → «Собрать» (brief
// approve) → the build followed by its v3_progress snapshots (stages, scenarios, ₽, the live preview) → G0–G2 and the
// first publication up to the founder's review → screenshots. Routes: apps/platform-api/src/routes/systems.ts,
// briefs/{routes,upload}.ts, directions/routes.ts, builds-v3/routes.ts, routes/runs.ts. Never throws per brief.
import {
  collectGaps,
  DEFAULTS,
  isReady,
  minutesBetween,
  newResult,
  probeG2,
  runEval,
  runTracker,
  summarizeGates,
} from "./driver.mjs";
import { shopPayment } from "./v3-pay.mjs";

/** D77_v3 (10)–(11): preview ≤ 5 min, a typical build 10–20 min (median ≤ 20), cap 30 min; ≤ 300 ₽ target, 500 ₽ cap. */
export const V3_TARGETS = { previewMin: 5, medianMin: 20, capMin: 30, targetRub: 300, capRub: 500 };
/** Defaults of the v3 driver: «Дальше решай сам» after 6 answers, the interview cap of 15 questions, the timeouts. */
export const V3_DEFAULTS = {
  restAfter: 6,
  maxQuestions: 15,
  maxTurns: 20,
  /** One brief (interview + directions + build ≤ 500 ₽ + publication): its runs are cancelled beyond this estimate. */
  maxBriefRub: 600,
  concurrency: 2,
  timeoutsMin: { interview: 20, build: 40, publish: 30 },
};
/**
 * The owner's data of the personal data operator (G2-PII-06, setCompliance): the build cannot invent them, the owner
 * gives them before publishing (the cabinet's settings, «Персональные данные»). The driver fills them as the owner would,
 * with clearly fake values — «ready» measures the system, not missing owner data (checkpoint 2026-10-09: 0 of 4).
 */
export const V3_TEST_OPERATOR = {
  operatorName: "ИП Тестов Т. Т.",
  operatorContact: "operator@test.example",
  operatorAddress: "г. Тестовск, ул. Тестовая, д. 1 (тестовые данные замера)",
};
/** The reserved option of a v3 question (agents interview-v3 DELEGATE_OPTION_ID). */
export const DELEGATE = "delegate";
/** The owner's line when the interview waits for a free text and the brief has nothing more to say. */
export const V3_FREE_TEXT = "Дальше решайте сами — по своим рекомендациям.";
/** Stages of the harness v3 in order (agents/builder-v3.md C6; workflows.yaml#events build_stage). */
export const V3_STAGE_IDS = [
  "brief",
  "design",
  "backend",
  "skeleton",
  "scenarios",
  "critic",
  "template_gate",
  "techreview",
  "gates",
];

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е");

/**
 * The owner's answer to one v3 question: «Дальше решай сам» once `answered` reached the brief's rest_after; else by
 * the brief's `answers[topic]` — "delegate" (the reserved option), {text} (once per topic, then the recommendation), an
 * option stem (the first option whose label holds it), "recommended" or nothing — the recommended option (else the
 * first). → {rest} | {optionId} | {text}, with `kind` for the report.
 */
export function v3Answer(q, brief, st = { answered: 0, texts: new Set() }) {
  const restAfter = brief.rest_after ?? V3_DEFAULTS.restAfter;
  if (st.answered >= restAfter) return { kind: "rest", rest: true };
  const all = Array.isArray(q?.options) ? q.options : [];
  const opts = all.filter((o) => o.id !== DELEGATE && !o.delegate);
  const rec = opts.find((o) => o.recommended) ?? opts[0] ?? null;
  const want = brief.answers?.[q?.topic];
  if (want === DELEGATE && all.some((o) => o.id === DELEGATE))
    return { kind: "delegate", optionId: DELEGATE };
  if (want && typeof want === "object" && typeof want.text === "string" && !st.texts.has(q.topic)) {
    st.texts.add(q.topic);
    return { kind: "text", text: want.text.trim().slice(0, 500) };
  }
  if (typeof want === "string" && want !== DELEGATE && want !== "recommended") {
    const hit = opts.find((o) => norm(o.label).includes(norm(want)));
    if (hit) return { kind: hit.recommended ? "recommended" : "option", optionId: hit.id };
  }
  if (rec) return { kind: "recommended", optionId: rec.id };
  if (all.some((o) => o.id === DELEGATE)) return { kind: "delegate", optionId: DELEGATE };
  return { kind: "text", text: V3_FREE_TEXT };
}

/** The body of POST /systems/:id/answers for an answer of v3Answer. */
export function answerBody(q, a) {
  if (a.rest) return { restByRecommendation: true };
  return {
    answers: [
      a.text !== undefined ? { questionId: q.id, text: a.text } : { questionId: q.id, optionId: a.optionId },
    ],
  };
}

const parseExpect = (x) => {
  const [label, stems = ""] = String(x).split("::");
  return {
    label: label.trim(),
    stems: stems
      .split("|")
      .map((s) => norm(s.trim()))
      .filter(Boolean),
  };
};

/**
 * Coverage of the brief's expectations (eval.yaml#briefs.format expected, stems in lower case, ё→е) by the final system
 * brief — roles in brief.roles, entities in brief.data, features anywhere in the brief, acceptance in the scenarios,
 * goals and the roles' rights; the weights of eval.yaml#metrics coverage (0.2, 0.3, 0.3, 0.2). Missing labels for the report.
 */
export function briefCoverage(sb, expected) {
  const hay = (x) => norm(JSON.stringify(x ?? ""));
  const part = (list, text) => {
    const xs = (list ?? []).map(parseExpect);
    const missing = xs.filter((x) => !x.stems.some((s) => text.includes(s))).map((x) => x.label);
    return { total: xs.length, found: xs.length - missing.length, missing };
  };
  const out = {
    roles: part(expected?.roles, hay(sb?.roles)),
    entities: part(expected?.entities, hay(sb?.data)),
    features: part(expected?.must_have_features, hay(sb)),
    acceptance: part(expected?.acceptance_criteria, hay([sb?.scenarios, sb?.goals, sb?.roles])),
  };
  const share = (p) => (p.total ? p.found / p.total : 1);
  out.score =
    Math.round(
      (0.2 * share(out.roles) +
        0.3 * share(out.entities) +
        0.3 * share(out.features) +
        0.2 * share(out.acceptance)) *
        100,
    ) / 100;
  return out;
}

/** Counts of the final system brief (C1) for the report; canaries — how many of the brief's canaries the brief keeps. */
export function briefSummary(v, canaries = []) {
  const b = v?.brief ?? {};
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  const sc = Array.isArray(b.scenarios) ? b.scenarios : [];
  const cap = Array.isArray(b.capability) ? b.capability : [];
  const text = norm(JSON.stringify(b));
  return {
    version: v?.version ?? null,
    goals: n(b.goals),
    scenarios: {
      must: sc.filter((s) => s.priority !== "should").length,
      should: sc.filter((s) => s.priority === "should").length,
    },
    roles: n(b.roles),
    data: n(b.data),
    integrations: n(b.integrations),
    outOfScope: n(b.outOfScope),
    assumptions: n(b.assumptions),
    qa: n(b.qa),
    capability: {
      modules: cap.filter((c) => c.level === "modules").length,
      custom: cap.filter((c) => c.level === "custom").length,
      not_yet: cap.filter((c) => c.level === "not_yet").length,
    },
    canariesKept: canaries.filter((c) => text.includes(norm(c))).length,
  };
}

/** Build state from the events of a v3 build run: stage times, the latest v3_progress, the first preview, the end. */
export function newBuildTrace() {
  return {
    startedAt: null,
    endedAt: null,
    previewAt: null,
    progress: null,
    stages: {},
    failure: null,
    lastSeq: 0,
  };
}

/** One event of the build run (SSE or run_events) into the trace; returns a line for the log or null. */
export function traceEvent(t, e, now = new Date()) {
  t.lastSeq = Math.max(t.lastSeq, Number(e.seq) || 0);
  const ts = e.ts ? new Date(e.ts) : now;
  const p = e.payload ?? {};
  let line = null;
  if (e.type === "run_started") t.startedAt ??= ts.toISOString();
  if (e.type === "build_stage" && typeof p.stage === "string") {
    t.stages[p.stage] ??= { id: p.stage, label: p.label_ru ?? p.stage, status: "pending" };
    const st = t.stages[p.stage];
    if (p.status === "started") {
      st.status = "running";
      st.startedAt = ts.toISOString();
    } else {
      st.status = p.status;
      st.finishedAt = ts.toISOString();
      st.sec = st.startedAt ? Math.max(0, Math.round((ts.getTime() - Date.parse(st.startedAt)) / 1000)) : 0;
      line = `этап «${st.label}»: ${STAGE_STATUS_RU[p.status] ?? p.status}${st.sec ? ` за ${st.sec} с` : ""}`;
    }
  }
  if (p.progress && typeof p.progress === "object") {
    t.progress = p.progress;
    if (p.progress.previewRevision !== null && p.progress.previewRevision !== undefined && !t.previewAt) {
      t.previewAt = ts.toISOString();
      line = `живое превью готово (ревизия ${p.progress.previewRevision})`;
    }
  }
  if (e.type === "run_failed") t.failure = { code: p.code ?? null, message_ru: p.message_ru ?? null };
  if (e.type === "run_finished" || e.type === "run_failed") t.endedAt = ts.toISOString();
  return line;
}

const STAGE_STATUS_RU = {
  done: "готов",
  reused: "взят из чекпоинта",
  skipped: "пропущен",
  failed: "не удался",
};

/** The build part of a result from the trace: minutes, preview, stages in order, ₽ of the harness, the scenarios. */
export function buildSummary(t, run) {
  const min = (a, b) => (a && b ? minutesBetween(new Date(a), new Date(b)) : null);
  const p = t.progress;
  const sc = Array.isArray(p?.scenarios) ? p.scenarios : [];
  const by = (s) => sc.filter((x) => x.status === s).length;
  const stages = V3_STAGE_IDS.map((id) => t.stages[id] ?? null)
    .filter(Boolean)
    .map((s) => ({ id: s.id, label: s.label, status: s.status, sec: s.sec ?? null }));
  for (const s of p?.stages ?? [])
    if (!stages.some((x) => x.id === s.id))
      stages.push({ id: s.id, label: s.label_ru, status: s.status, sec: null });
  stages.sort((a, b) => V3_STAGE_IDS.indexOf(a.id) - V3_STAGE_IDS.indexOf(b.id));
  return {
    runId: run?.id ?? null,
    status: run?.status ?? "unknown",
    ...(run?.failure || t.failure ? { failure: run?.failure ?? t.failure } : {}),
    startedAt: t.startedAt,
    finishedAt: t.endedAt,
    minutes: min(t.startedAt, t.endedAt),
    previewMinutes: min(t.startedAt, t.previewAt),
    stages,
    spentRub: Number.isFinite(p?.spentRub) ? p.spentRub : null,
    reusedRub: Number.isFinite(p?.reusedRub) ? p.reusedRub : null,
    capRub: Number.isFinite(p?.capRub) ? p.capRub : null,
    scenarios: {
      total: sc.length,
      passed: by("passed"),
      failed: by("failed"),
      stopped: by("stopped"),
      toRequests: by("failed") + by("stopped"),
      mustNotPassed: sc.filter((x) => x.priority === "must" && x.status !== "passed").length,
      list: sc.map((x) => ({
        id: x.id,
        title: x.title,
        priority: x.priority,
        status: x.status,
        ...(x.reason ? { reason: x.reason } : {}),
      })),
    },
  };
}

/** Skeleton result of a v3 brief (newResult of the driver plus the v3 parts the report reads). */
export function newV3Result(brief) {
  return {
    ...newResult(brief),
    pipeline: null,
    interview: {
      turns: 0,
      questions: 0,
      retries: 0,
      free: 0,
      restAt: null,
      by: { recommended: 0, option: 0, delegate: 0, text: 0 },
      minutes: null,
    },
    tz: null,
    direction: null,
    brief: null,
    coverage: null,
    techreview: null,
    owner: { operator: null },
  };
}

/**
 * The owner's step before publishing: the operator's data the system asks for (publishBlockers OPERATOR_*), filled
 * through PUT /systems/:id/compliance as the cabinet's settings do. → {filled, revision, blockers}; never throws.
 */
export async function fillOwnerOperator(client, systemId, say = () => {}) {
  try {
    const s = (await client.get(`/systems/${systemId}`)).body;
    const need = (s.publishBlockers ?? []).filter((b) => /^OPERATOR_/.test(String(b)));
    if (!need.length) return { filled: false, revision: null, blockers: [] };
    const res = await client.put(`/systems/${systemId}/compliance`, {
      expectedVersion: s.system.draftRevision,
      ...V3_TEST_OPERATOR,
    });
    const revision = res.body?.revision?.version ?? null;
    say(`владелец указал данные оператора ПДн (тестовые): ревизия ${revision ?? "—"}`);
    return { filled: true, revision, blockers: need };
  } catch (e) {
    say(`данные оператора ПДн не сохранены: ${e?.message ?? e}`);
    return { filled: false, revision: null, blockers: [], error: String(e?.message ?? e).slice(0, 300) };
  }
}

/**
 * G0–G2 of the latest reports as the owner sees them: the build's G2 ran before the owner gave the operator's data,
 * so its G2-PII-06 is the owner's action (filled since), not a blocker of the system.
 */
export function ownerGates(latest, operator, o = {}) {
  const g = summarizeGates(latest, o);
  if (!operator?.filled || o.beforePublish) return g;
  const g2 = g.G2?.revision ?? null;
  return g2 !== null && operator.revision !== null && g2 >= operator.revision
    ? g
    : summarizeGates(latest, { ...o, beforePublish: true });
}

/** v3 readiness: the build succeeded, G0–G2 without blockers, no techreview blocker, every «must» scenario passed. */
export function isReadyV3(r, g2Mode) {
  return (
    r.build?.status === "succeeded" &&
    isReady(r.gates ?? {}, g2Mode) &&
    !r.techreview?.blocked &&
    r.payment?.status !== "failed" &&
    (r.build?.scenarios?.mustNotPassed ?? 1) === 0
  );
}

/** Drives one v3 brief (see the head of the file); never throws. `ctx` as driveBrief's plus maxQuestions, screenshot. */
export async function driveV3Brief(ctx, brief, r = newV3Result(brief)) {
  const { client, now, log } = ctx;
  const say = (m) => log(`${brief.id}: ${m}`);
  const { waitRun } = runTracker(ctx, r, say);
  const id = () => r.systemId;
  const failure = (run) => run.failure?.message_ru || run.failure?.code || run.status;
  const maxQuestions = ctx.maxQuestions ?? V3_DEFAULTS.maxQuestions;
  const maxTurns = ctx.maxTurns ?? V3_DEFAULTS.maxTurns;
  const latestGates = async () => (await client.get(`/systems/${id()}/gates/latest`)).body;
  r.startedAt = now().toISOString();
  r.status = "running";
  try {
    // 1. The interview.
    const created = (
      await client.post("/systems", { prompt: brief.text, ...(ctx.orgId ? { orgId: ctx.orgId } : {}) })
    ).body;
    r.systemId = created.system.id;
    say(`система ${r.systemId}, грилл-интервью v3`);
    let run = await waitRun(created.run, "interview");
    const st = { answered: 0, texts: new Set() };
    let lastBody = null;
    let checked = false;
    for (;;) {
      r.interview.turns += 1;
      if (run.status !== "succeeded") {
        // A retryable failed turn is repeated once, like the client's «Повторить».
        if (run.failure?.retryable && r.interview.retries < 1) {
          r.interview.retries += 1;
          say(`ход интервью не удался (${failure(run)}) — повтор хода`);
          const m = lastBody
            ? await client.post(`/systems/${id()}/answers`, lastBody)
            : await client.post(`/systems/${id()}/messages`, { text: brief.text });
          run = await waitRun(m.body.run, "interview");
          continue;
        }
        r.status = "interview_failed";
        r.error = `интервью: ${failure(run)}`;
        return r;
      }
      const s = (await client.get(`/systems/${id()}`)).body;
      if (s.pipeline) r.pipeline = s.pipeline;
      const pending = Array.isArray(s.pendingQuestions) ? s.pendingQuestions : [];
      if (!checked) {
        checked = true;
        // A v3 system has a brief from its first turn and «Решите за меня» in its questions; anything else means the
        // eval org is not on v3 on this server — every brief would cost an interview for nothing.
        const v = (await client.get(`/systems/${id()}/brief`)).body?.brief ?? null;
        const v3 = v !== null || pending.some((q) => (q.options ?? []).some((o) => o.id === DELEGATE));
        if (!v3) {
          const why =
            "система началась не на конвейере v3: организация замера не включена в WIZARD_BUILD_PIPELINE_ORGS на сервере";
          r.status = "interview_failed";
          r.error = why;
          ctx.abortRun?.(why);
          return r;
        }
        // 1a. The ТЗ file after the first turn (the draft fills the empty sections, the interview asks the rest).
        if (brief.tz) r.tz = await uploadTz(client, id(), brief, say);
      }
      if (s.system.stage === "card" && pending.length === 0) break;
      if (r.interview.turns >= maxTurns) {
        r.status = "interview_failed";
        r.error = `интервью не дошло до готового брифа за ${maxTurns} ходов`;
        return r;
      }
      if (pending.length > 0) {
        const q = pending[0];
        const a =
          r.interview.questions >= maxQuestions ? { kind: "rest", rest: true } : v3Answer(q, brief, st);
        r.interview.questions += 1;
        if (a.rest) r.interview.restAt ??= r.interview.questions;
        else {
          st.answered += 1;
          r.interview.by[a.kind] += 1;
        }
        lastBody = answerBody(q, a);
        const m = await client.post(`/systems/${id()}/answers`, lastBody);
        run = await waitRun(m.body.run, "interview");
      } else if (s.system.stage === "interview") {
        r.interview.free += 1;
        lastBody = null;
        const m = await client.post(`/systems/${id()}/messages`, { text: V3_FREE_TEXT });
        run = await waitRun(m.body.run, "interview");
      } else {
        r.status = "interview_failed";
        r.error = `после интервью система на этапе «${s.system.stage}», брифа к сборке нет`;
        return r;
      }
    }
    r.interview.minutes = minutesBetween(new Date(r.startedAt), now());
    // D77 (10), (16): the build's time targets run from the ready brief — the interview is the owner's time.
    r.briefAt = now().toISOString();
    say(
      `бриф готов: вопросов ${r.interview.questions}${r.interview.restAt ? `, «Дальше решай сам» на ${r.interview.restAt}-м` : ""}`,
    );

    // 2. Three directions and the pick (optional for the build: a failure is noted, «Собрать» goes on).
    r.direction = await pickDirection(client, id(), brief, say);

    // 3. The brief as approved, «Собрать».
    const bv = (await client.get(`/systems/${id()}/brief`)).body?.brief;
    if (!bv?.version) throw new Error("бриф системы не прочитан перед «Собрать»");
    r.brief = briefSummary(bv, brief.canaries ?? []);
    r.coverage = briefCoverage(bv.brief, brief.expected);
    const ap = await client.post(`/systems/${id()}/brief/approve`, { version: bv.version });
    say(`«Собрать» по брифу версии ${bv.version} (потолок ${ap.body?.capCredits ?? "—"} кредитов)`);

    // 4. The build, followed by its v3_progress snapshots.
    const t = newBuildTrace();
    const read = async (runId, timeoutMs) => {
      let evs = [];
      try {
        evs = await client.readEvents(runId, { after: t.lastSeq, timeoutMs });
      } catch (e) {
        say(`события сборки не прочитаны: ${e?.message ?? e}`);
        await ctx.sleep(ctx.pollMs);
      }
      for (const e of evs) {
        const line = traceEvent(t, e, now());
        if (line) say(line);
      }
      if (evs.length) ctx.onUpdate?.();
    };
    let build;
    try {
      build = await waitRun(ap.body.run, "build", { onPoll: (x) => read(x.id, ctx.pollMs) });
    } finally {
      // The tail of the stream: the stages after the last poll and run_finished / run_failed.
      if (ap.body?.run?.id) await read(ap.body.run.id, 5_000);
      r.build = buildSummary(t, build ?? { id: ap.body?.run?.id, status: "cancelled" });
      r.buildMinutes = r.build.minutes;
    }
    const msg = String(build.failure?.message_ru ?? "");
    const tr = r.build.stages.find((s) => s.id === "techreview");
    r.techreview = {
      status: tr?.status ?? "not_reached",
      blocked: build.status !== "succeeded" && /^Техревью нашло/.test(msg),
      ...(msg && /^Техревью нашло/.test(msg) ? { message: msg.slice(0, 300) } : {}),
    };
    const end = now();
    r.minutes = minutesBetween(new Date(r.startedAt), end);
    r.fromBriefMinutes = minutesBetween(new Date(r.briefAt), end);
    say(
      `сборка ${build.status === "succeeded" ? "завершилась" : `не завершилась (${failure(build)})`}: ${r.build.minutes ?? "—"} мин, превью через ${r.build.previewMinutes ?? "—"} мин, сценарии ${r.build.scenarios.passed} из ${r.build.scenarios.total}, ≈ ${r.build.spentRub ?? "—"} ₽`,
    );

    // 5. The owner's data before publishing (the operator of personal data), then G0–G2 and the first publication
    // (on the pilot it waits for the founder's review).
    if (build.status === "succeeded") r.owner.operator = await fillOwnerOperator(client, id(), say);
    // V3-23: the shop's online payment through the founder's ЮKassa test shop (keys by the key window, a purchase on
    // the draft's preview) — before G2, which wants the keys of the payment in the secret store.
    if (build.status === "succeeded" && ctx.kassa) r.payment = await shopPayment(ctx, client, id(), say);
    let gates = ownerGates(await latestGates(), r.owner.operator);
    if (ctx.g2 === "publish" && build.status === "succeeded" && gates.G0?.passed && gates.G1?.passed) {
      r.publish = await probeG2(ctx, r, waitRun, say);
      gates = ownerGates(await latestGates(), r.owner.operator);
    } else {
      r.publish = { status: ctx.g2 === "publish" ? "not_publishable" : "skipped" };
      gates = summarizeGates(await latestGates(), { beforePublish: true });
    }
    r.gates = gates;
    r.ready = isReadyV3(r, ctx.g2);
    r.status = r.ready ? "ready" : build.status !== "succeeded" ? "build_failed" : "not_ready";
    say(r.ready ? `готова (${r.minutes} мин)` : `не готова: ${r.status}`);
  } catch (e) {
    r.status = r.status === "running" ? "error" : r.status;
    r.error = String(e?.message ?? e).slice(0, 500);
    say(`ошибка: ${r.error}`);
    if (e?.code === "LLM_BUDGET_EXHAUSTED") ctx.abortRun?.("дневной лимит платформы на модели исчерпан");
  } finally {
    if (r.systemId)
      await collectGaps(client, r)
        .then((g) => Object.assign(r.gaps, g))
        .catch((e) => say(`пробелы не прочитаны: ${e?.message ?? e}`));
    if (r.systemId && ctx.screenshot && r.build)
      await Promise.resolve(ctx.screenshot(r))
        .then((shots) => {
          r.screenshots = (Array.isArray(shots) ? shots : []).slice(0, 4);
        })
        .catch((e) => say(`скриншоты не сняты: ${e?.message ?? e}`));
    r.finishedAt = now().toISOString();
  }
  return r;
}

/** The ТЗ file of the brief → POST /systems/:id/brief/upload; the outcome for the report (never throws). */
async function uploadTz(client, systemId, brief, say) {
  const name = `tz.${brief.tz.format}`;
  try {
    const res = await client.upload(`/systems/${systemId}/brief/upload`, {
      name,
      type: brief.tz.format === "md" ? "text/markdown" : "text/plain",
      data: new TextEncoder().encode(brief.tz.text),
    });
    const b = res.body ?? {};
    const out = {
      uploaded: true,
      format: brief.tz.format,
      version: b.brief?.version ?? null,
      method: b.source?.method ?? null,
      piiReplaced: b.source?.piiReplaced ?? null,
      gaps: Array.isArray(b.gaps) ? b.gaps.length : null,
    };
    say(
      `ТЗ приложено: бриф версии ${out.version}, черновик — ${out.method === "model" ? "моделью" : "без модели"}`,
    );
    return out;
  } catch (e) {
    say(`ТЗ не принято: ${e?.message ?? e}`);
    return { uploaded: false, format: brief.tz.format, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Three directions (POST /systems/:id/directions) and the brief's pick (n or «Решите за меня»); never throws. */
async function pickDirection(client, systemId, brief, say) {
  const want = brief.direction ?? 1;
  try {
    const p = (await client.post(`/systems/${systemId}/directions`, {})).body?.proposal;
    if (!p?.id || !Array.isArray(p.directions) || p.directions.length === 0)
      return { error: "направления не предложены" };
    const n = want === DELEGATE ? null : Math.min(Number(want) || 1, p.directions.length);
    const picked = (
      await client.post(
        `/systems/${systemId}/directions/pick`,
        n === null ? { proposalId: p.id, skip: true } : { proposalId: p.id, n },
      )
    ).body;
    const out = {
      proposalId: p.id,
      names: p.directions.map((d) => d.name),
      archetypes: p.directions.map((d) => d.archetype),
      costRub: Number(p.costRub ?? 0),
      fallback: !!p.fallback,
      n,
      archetype: picked?.archetype ?? null,
      pinned: !!picked?.pinned,
      briefVersion: picked?.brief?.version ?? null,
    };
    say(
      `направления: ${out.names.map((x) => `«${x}»`).join(", ")}; ${n === null ? "«Решите за меня»" : `выбрано ${n}-е`} → ${out.archetype}`,
    );
    return out;
  } catch (e) {
    say(`направления не выбраны: ${e?.message ?? e} — сборка без закреплённого стиля`);
    return { error: String(e?.message ?? e).slice(0, 300) };
  }
}

/**
 * The v3 measurement: runEval of the driver with driveV3Brief, the v3 defaults (concurrency 2, the brief cap, the
 * timeouts) and the hard stop of the run's cap (maxCostRub). `o.threshold` v3-final (V3-40) keeps its name in the
 * document — the final report reads it; anything else is the checkpoint (v3).
 */
export function runV3Eval(o) {
  return runEval({
    ...o,
    threshold: o.threshold === "v3-final" ? "v3-final" : "v3",
    drive: driveV3Brief,
    newResult: newV3Result,
    concurrency: o.concurrency ?? V3_DEFAULTS.concurrency,
    maxBriefRub: o.maxBriefRub ?? V3_DEFAULTS.maxBriefRub,
    timeoutsMin: { ...DEFAULTS.timeoutsMin, ...V3_DEFAULTS.timeoutsMin, ...(o.timeoutsMin ?? {}) },
    failFast: false,
  });
}
