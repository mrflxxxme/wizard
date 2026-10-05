// D67 measurement driver (product.yaml#decisions.D67_mvp_readiness, backlog M2-88 mvp_scope): each brief goes through
// the real pipeline of the pilot server the way a client does it in the cabinet — createSystem → interview (button
// questions: the recommended option, else the first; a free question: a short answer from the brief) → card →
// approveCard → build (needs_input answered like a client would) → one «Исправить» when checks failed → the G2 probe:
// the first publication, which on the pilot runs G0–G2 and then waits for the founder's review (nothing reaches prod
// while orgs.require_founder_review is on). Routes: apps/platform-api/src/routes/{systems,runs,publish}.ts.

/** agents/models.yaml#credits.rub_per_credit: 1 credit ≈ 5 ₽ of model cost (credits_milli = ceil(cost × 1000 / 5)). */
export const RUB_PER_CREDIT = 5;
/** D67 threshold: ≥ 7 of 10 briefs reach publish readiness. */
export const D67_THRESHOLD = { ready: 7, of: 10 };
export const DEFAULTS = {
  maxCostRub: 2000,
  concurrency: 2,
  fixAttempts: 1,
  g2: "publish",
  pollMs: 5000,
  maxTurns: 8,
  maxInputs: 4,
  timeoutsMin: { interview: 15, build: 120, publish: 30 },
};
/**
 * G2 checks that need the owner, not the builder: PROD values of integration secrets (G2-SECRET-02, e.g. the Telegram
 * bot token) are entered by the owner before the first publication. They are listed apart and do not fail readiness.
 */
export const OWNER_ACTION_CHECKS = new Set(["G2-SECRET-02"]);
/** Operator data of the eval org (setCompliance): test values, the system never reaches prod (founder review). */
export const TEST_OPERATOR = {
  operatorName: "Тестовый оператор замера D67",
  operatorAddress: "Тестовые данные замера D67, не для публикации",
};
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const AVOID_CHOICES = new Set(["stop", "rollback", "cancel"]);
const LEVELS = ["G0", "G1", "G2"];

/** Button question → the option a client accepts: the recommended one, else the first (postAnswers). */
export function pickOption(q) {
  const opts = Array.isArray(q?.options) ? q.options : [];
  return opts.find((o) => o.recommended) ?? opts[0] ?? null;
}

/**
 * needs_input (workflows.yaml#events.needs_input) → a client's choice: a decision gets the recommended option, else
 * the first that keeps the build going (not stop / rollback); free-text options are skipped. A secret gets its test
 * mode when offered, else null — the driver cancels the run (it never invents secret values).
 */
export function pickDecision(p) {
  const opts = (Array.isArray(p?.options) ? p.options : []).filter((o) => !o.freeText);
  if (p?.kind === "secret") return opts.find((o) => o.id === "test")?.id ?? null;
  const keep = opts.filter((o) => !AVOID_CHOICES.has(o.id));
  return (keep.find((o) => o.recommended) ?? keep[0] ?? opts[0])?.id ?? null;
}

/** A short answer to a free question of the orchestrator, from the brief (≤ 500 characters, postMessage). */
export function freeAnswer(brief) {
  const base = String(brief.free_answer ?? "Всё, что знаю, написал в описании").trim().replace(/[.\s]+$/u, "");
  return `${base}. Остальное решите сами, по своим рекомендациям.`.slice(0, 500);
}

/** GateReport[] of getLatestGates → per level {passed, revision, blockers, ownerActions, warnings}. */
export function summarizeGates(latest) {
  const out = {};
  for (const rep of latest?.reports ?? []) {
    if (!LEVELS.includes(rep.level)) continue;
    const failed = (rep.checks ?? []).filter(
      (c) => (c.status === "fail" || c.status === "error") && c.severity === "blocker",
    );
    const line = (c) => ({ id: c.id, message: String(c.message_ru ?? "").slice(0, 300) });
    out[rep.level] = {
      passed: rep.passed === true,
      revision: rep.specVersion ?? latest.revision ?? null,
      blockers: failed.filter((c) => !OWNER_ACTION_CHECKS.has(c.id)).map(line),
      ownerActions: failed.filter((c) => OWNER_ACTION_CHECKS.has(c.id)).map(line),
      warnings: (rep.checks ?? []).filter((c) => c.status === "warn" || c.severity === "warning").length,
    };
  }
  return out;
}

/** D67 readiness of a brief: G0 and G1 passed, G2 passed or failed only on owner actions (G2 off → G0 + G1). */
export function isReady(gates, g2Mode) {
  if (!gates.G0?.passed || !gates.G1?.passed) return false;
  if (g2Mode === "skip") return true;
  const g2 = gates.G2;
  return !!g2 && (g2.passed || g2.blockers.length === 0);
}

/** Skeleton result of a brief (filled by driveBrief; what report.mjs reads). */
export function newResult(brief) {
  return {
    id: brief.id,
    class: brief.class ?? null,
    title: brief.title,
    beyond: brief.beyond ? { gapStems: brief.beyond.gap_stems } : null,
    status: "pending",
    ready: false,
    systemId: null,
    error: null,
    interview: { turns: 0, buttons: 0, free: 0 },
    card: null,
    build: null,
    fixes: 0,
    inputs: [],
    publish: null,
    gates: {},
    gaps: { outOfScope: [], mentions: [] },
    runs: [],
    creditsUsed: 0,
    costRubEstimate: 0,
    minutes: null,
    buildMinutes: null,
    startedAt: null,
    finishedAt: null,
  };
}

const minutesBetween = (a, b) => Math.round(((b.getTime() - a.getTime()) / 60_000) * 10) / 10;

/**
 * Drives one brief; never throws (an API error ends the brief with status error). `ctx`: {client, orgId, ownerEmail,
 * g2, fixAttempts, pollMs, maxTurns, maxInputs, timeoutsMin, now, sleep, log, onSpend}.
 */
export async function driveBrief(ctx, brief, r = newResult(brief)) {
  const { client, now, log } = ctx;
  const say = (m) => log(`${brief.id}: ${m}`);
  const runs = new Map();
  const track = (run) => {
    if (!run?.id) return;
    runs.set(run.id, {
      id: run.id,
      kind: run.kind,
      ...(run.mode ? { mode: run.mode } : {}),
      status: run.status,
      creditsUsed: Number(run.credits?.used ?? 0),
      ...(run.failure ? { failure: run.failure } : {}),
    });
    r.runs = [...runs.values()];
    r.creditsUsed = Math.round(r.runs.reduce((s, x) => s + x.creditsUsed, 0) * 1000) / 1000;
    r.costRubEstimate = Math.round(r.creditsUsed * RUB_PER_CREDIT * 100) / 100;
    ctx.onSpend?.();
  };

  /** Answers the open needs_input of the run; false when the run must stop (no answer possible, too many asks). */
  async function answerInput(run, answered) {
    const events = await client.readEvents(run.id, {
      after: 0,
      stop: (e) => e.type === "needs_input" && !answered.has(e.payload.inputId),
      timeoutMs: 20_000,
    });
    const received = new Set(events.filter((e) => e.type === "input_received").map((e) => e.payload.inputId));
    const ask = events
      .filter((e) => e.type === "needs_input" && !answered.has(e.payload.inputId))
      .filter((e) => !received.has(e.payload.inputId))
      .at(-1);
    if (!ask) return true;
    const p = ask.payload;
    answered.add(p.inputId);
    const choice = answered.size > ctx.maxInputs ? null : pickDecision(p);
    r.inputs.push({ kind: p.kind, decisionId: p.decisionId ?? null, choice });
    if (choice === null) return false;
    say(`ответ на запрос сборки ${p.decisionId ?? p.kind}: ${choice}`);
    await client.post(`/runs/${run.id}/input`, { inputId: p.inputId, choice });
    return true;
  }

  async function waitRun(first, phase) {
    const deadline = now().getTime() + ctx.timeoutsMin[phase] * 60_000;
    const answered = new Set();
    let run = first;
    for (;;) {
      track(run);
      if (TERMINAL.has(run.status)) return run;
      if (run.status === "needs_input" && !(await answerInput(run, answered))) {
        await client.post(`/runs/${run.id}/cancel`).catch(() => {});
        throw new Error(
          `прогон ${phase} попросил ответ, который замер дать не может (секрет или больше ${ctx.maxInputs} вопросов) — отменён`,
        );
      }
      if (now().getTime() > deadline) {
        await client.post(`/runs/${run.id}/cancel`).catch(() => {});
        throw new Error(`прогон ${phase} не завершился за ${ctx.timeoutsMin[phase]} мин — отменён`);
      }
      await ctx.sleep(ctx.pollMs);
      run = (await client.get(`/runs/${run.id}`)).body;
    }
  }

  const latestGates = async () => (await client.get(`/systems/${r.systemId}/gates/latest`)).body;
  const failure = (run) => run.failure?.message_ru || run.failure?.code || run.status;

  r.startedAt = now().toISOString();
  r.status = "running";
  try {
    // Interview.
    const created = (await client.post("/systems", { prompt: brief.text, ...(ctx.orgId ? { orgId: ctx.orgId } : {}) }))
      .body;
    r.systemId = created.system.id;
    say(`система ${r.systemId}, интервью`);
    let run = await waitRun(created.run, "interview");
    let card = null;
    for (;;) {
      r.interview.turns += 1;
      if (run.status !== "succeeded") {
        r.status = "interview_failed";
        r.error = `интервью: ${failure(run)}`;
        return r;
      }
      const s = (await client.get(`/systems/${r.systemId}`)).body;
      if (s.system.stage === "card" && s.card) {
        card = s.card;
        break;
      }
      if (r.interview.turns >= ctx.maxTurns) {
        r.status = "interview_failed";
        r.error = `интервью не дошло до карточки за ${ctx.maxTurns} ходов`;
        return r;
      }
      const pending = Array.isArray(s.pendingQuestions) ? s.pendingQuestions : [];
      if (pending.length > 0) {
        const answers = pending
          .map((q) => ({ q, o: pickOption(q) }))
          .filter((x) => x.o)
          .map(({ q, o }) => ({ questionId: q.id, optionId: o.id }));
        r.interview.buttons += answers.length;
        const a = await client.post(`/systems/${r.systemId}/answers`, {
          answers,
          restByRecommendation: true,
        });
        run = await waitRun(a.body.run, "interview");
      } else if (s.system.stage === "interview") {
        r.interview.free += 1;
        const m = await client.post(`/systems/${r.systemId}/messages`, { text: freeAnswer(brief) });
        run = await waitRun(m.body.run, "interview");
      } else {
        r.status = "interview_failed";
        r.error = `после интервью система на этапе «${s.system.stage}», карточки нет`;
        return r;
      }
    }
    r.card = {
      cardVersion: card.cardVersion,
      title: card.title ?? null,
      capCredits: card.cap?.credits ?? null,
      outOfScope: Array.isArray(card.outOfScope) ? card.outOfScope.map((x) => String(x).slice(0, 300)) : [],
    };
    r.gaps.outOfScope = r.card.outOfScope;

    // Build (+ one «Исправить» per fixAttempts when checks failed).
    say(`карточка v${card.cardVersion} одобрена, сборка`);
    const buildStart = now();
    const ap = await client.post(`/systems/${r.systemId}/card/approve`, { cardVersion: card.cardVersion });
    let build = await waitRun(ap.body.run, "build");
    let gates = summarizeGates(await latestGates());
    for (let k = 0; k < ctx.fixAttempts; k++) {
      const failed = build.status !== "succeeded" || ["G0", "G1"].some((l) => gates[l] && !gates[l].passed);
      if (!failed) break;
      let fx;
      try {
        fx = await client.post(`/systems/${r.systemId}/fix`, {});
      } catch (e) {
        if (e?.code === "NO_GATE_FAILURE") break;
        throw e;
      }
      r.fixes += 1;
      say("проверки не прошли — «Исправить»");
      build = await waitRun(fx.body.run, "build");
      gates = summarizeGates(await latestGates());
    }
    const end = now();
    r.build = { status: build.status, ...(build.failure ? { failure: build.failure } : {}) };
    r.buildMinutes = minutesBetween(buildStart, end);
    r.minutes = minutesBetween(new Date(r.startedAt), end);

    // G2: the first publication (on the pilot it stops at the founder's review after G0–G2).
    if (ctx.g2 === "publish" && gates.G0?.passed && gates.G1?.passed) {
      r.publish = await probeG2(ctx, r, waitRun, say);
      gates = summarizeGates(await latestGates());
    } else r.publish = { status: ctx.g2 === "publish" ? "not_publishable" : "skipped" };
    r.gates = gates;
    r.ready = isReady(gates, ctx.g2);
    r.status = r.ready
      ? "ready"
      : build.status !== "succeeded" && !gates.G0?.passed
        ? "build_failed"
        : "not_ready";
    if (r.beyond) r.gaps.mentions = await gapMentions(client, r.systemId, r.beyond.gapStems);
    say(r.ready ? `готова к публикации (${r.minutes} мин)` : `не готова: ${r.status}`);
  } catch (e) {
    r.status = r.status === "running" ? "error" : r.status;
    r.error = String(e?.message ?? e).slice(0, 500);
    say(`ошибка: ${r.error}`);
  } finally {
    r.finishedAt = now().toISOString();
  }
  return r;
}

/** Owner-side preconditions (operator data with test values), then publish → status of the publish run. */
async function probeG2(ctx, r, waitRun, say) {
  const { client } = ctx;
  const out = { status: "pending", complianceFilled: false, blockers: [] };
  let s = (await client.get(`/systems/${r.systemId}`)).body;
  if ((s.publishBlockers ?? []).some((b) => String(b).startsWith("OPERATOR_"))) {
    await client.put(`/systems/${r.systemId}/compliance`, {
      expectedVersion: s.system.draftRevision,
      ...TEST_OPERATOR,
      operatorContact: ctx.ownerEmail,
    });
    out.complianceFilled = true;
    s = (await client.get(`/systems/${r.systemId}`)).body;
  }
  out.blockers = s.publishBlockers ?? [];
  if (out.blockers.includes("GATES_FAILED")) return { ...out, status: "not_publishable" };
  say("публикация: проверки G0–G2");
  let p;
  try {
    p = await client.post(`/systems/${r.systemId}/publish`, { revision: s.system.draftRevision });
  } catch (e) {
    return { ...out, status: "refused", code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 300) };
  }
  const run = await waitRun(p.body.run, "publish");
  if (run.status === "succeeded") return { ...out, status: "published" };
  const after = (await client.get(`/systems/${r.systemId}`)).body.publishBlockers ?? [];
  return {
    ...out,
    status: after.includes("FOUNDER_REVIEW_PENDING") ? "review_pending" : "failed",
    message: String(run.failure?.message_ru ?? "").slice(0, 300),
  };
}

/** Assistant messages of the system that speak about what the platform cannot do yet (beyond briefs). */
async function gapMentions(client, systemId, stems) {
  const msgs = (await client.get(`/systems/${systemId}/messages?limit=100`)).body.items ?? [];
  const low = stems.map((s) => s.toLowerCase());
  return msgs
    .filter((m) => m.role === "assistant" && typeof m.text === "string")
    .map((m) => m.text)
    .filter((t) => low.some((s) => t.toLowerCase().includes(s)))
    .map((t) => t.slice(0, 300))
    .slice(0, 3);
}

/**
 * Runs `briefs` with `concurrency` workers in order; a brief starts only while the estimated spend (credits × 5 ₽ of
 * finished and running briefs) is below `maxCostRub`, the rest are skipped. Returns the run document for report.mjs.
 */
export async function runEval(o) {
  const ctx = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
    timeoutsMin: { ...DEFAULTS.timeoutsMin, ...(o.timeoutsMin ?? {}) },
    now: o.now ?? (() => new Date()),
    sleep: o.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))),
    log: o.log ?? ((s) => console.log(s)),
  };
  const results = o.briefs.map((b) => newResult(b));
  const spent = () => results.reduce((s, x) => s + x.costRubEstimate, 0);
  const startedAt = ctx.now().toISOString();
  let next = 0;
  let peak = 0;
  let active = 0;
  async function worker() {
    while (next < o.briefs.length) {
      const i = next++;
      const r = results[i];
      if (spent() >= ctx.maxCostRub) {
        r.status = "skipped";
        r.error = `бюджет замера ${ctx.maxCostRub} ₽ исчерпан до старта`;
        ctx.log(`${r.id}: пропущен — бюджет исчерпан`);
        continue;
      }
      active += 1;
      peak = Math.max(peak, active);
      try {
        await driveBrief(ctx, o.briefs[i], r);
      } finally {
        active -= 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, worker));
  return {
    kind: "d67",
    base: ctx.client.base,
    runId: o.runId ?? null,
    orgId: ctx.orgId ?? null,
    startedAt,
    finishedAt: ctx.now().toISOString(),
    maxCostRub: ctx.maxCostRub,
    concurrency: ctx.concurrency,
    peakConcurrency: peak,
    g2: ctx.g2,
    fixAttempts: ctx.fixAttempts,
    results,
  };
}
