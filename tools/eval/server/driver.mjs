// D67 measurement driver (product.yaml#decisions.D67_mvp_readiness, backlog M2-88 mvp_scope): each brief goes through
// the real pipeline of the pilot server the way a client does it in the cabinet — createSystem → interview (button
// questions: the recommended option, else the first; a free question: a short answer from the brief) → card →
// approveCard → build (needs_input answered like a client would) → one «Исправить» when checks failed → the G2 probe:
// the first publication, which on the pilot runs G0–G2 and then waits for the founder's review (nothing reaches prod
// while orgs.require_founder_review is on). Routes: apps/platform-api/src/routes/{systems,runs,publish}.ts.
// Beta v2 (D76, modules pipeline): the goal interview ends with a system plan awaiting approval instead of a card —
// the driver reads it (GET /systems/:id/plan) and approves it as it is (POST /systems/:id/plan/approve, routes/plans.ts).

/** agents/models.yaml#credits.rub_per_credit: 1 credit ≈ 5 ₽ of model cost (credits_milli = ceil(cost × 1000 / 5)). */
export const RUB_PER_CREDIT = 5;
/** D67 threshold: ≥ 7 of 10 briefs reach publish readiness. */
export const D67_THRESHOLD = { ready: 7, of: 10 };
/**
 * D76 strict threshold of beta v2 (product.yaml#decisions.D76_beta_v2 (6), eval.yaml#thresholds.by_milestone.B2):
 * a brief is «covered» when its approved plan has no custom part and nothing out of scope — all covered briefs ready
 * (G0–G2 without blockers, goal scenarios in the browser, 390 px); every uncovered brief reaches a working system and
 * what is out of scope is recorded in «Запросы на развитие».
 */
export const THRESHOLDS = ["d67", "d76"];
/** Budget of the D76 measurement by default, ₽ (eval.yaml#thresholds.by_milestone.B2: ≤ 300 ₽ for the final run). */
export const D76_MAX_COST_RUB = 300;
/** D76 economics of one build (D76 (8)): ≤ 15 ₽ and ≤ 5 min without custom code, custom code ≤ +20 ₽. */
export const D76_ECONOMY = { buildRub: 15, buildMinutes: 5, customExtraRub: 20 };
/** Brief statuses that will not change any more (fail-fast counts them). */
/** B2-41: a retryable failed interview or plan turn is repeated this many times (the client's «Повторить»). */
export const MAX_TURN_RETRIES = 1;
export const FINAL = new Set(["ready", "not_ready", "build_failed", "interview_failed", "error", "skipped"]);
export const DEFAULTS = {
  maxCostRub: 2000,
  /** D75: one brief may spend at most this much; the run is cancelled beyond it (never a raised build cap). */
  maxBriefRub: 80,
  concurrency: 2,
  fixAttempts: 1,
  g2: "publish",
  pollMs: 5000,
  maxTurns: 8,
  maxInputs: 4,
  timeoutsMin: { interview: 15, build: 120, publish: 30 },
  threshold: "d67",
};
/**
 * G2 checks that need the owner, not the builder: PROD values of integration secrets (G2-SECRET-02, e.g. the Telegram
 * bot token) are entered by the owner before the first publication. They are listed apart and do not fail readiness.
 */
export const OWNER_ACTION_CHECKS = new Set(["G2-SECRET-02"]);
/**
 * Owner data the build's G2 cannot have yet (B2-21: blocks the publication, not the build): the operator of personal
 * data (G2-PII-06). The driver fills it with TEST_OPERATOR before publishing and the publication's G2 checks it as a
 * blocker; when the publication did not start (G0/G1 failed), the build's G2 shows it to the owner, not as a cause.
 */
export const OWNER_INPUT_CHECKS = new Set(["G2-PII-06"]);
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
  // D75: the measurement never raises a build's credit cap — a build that ran out of its cap is not ready.
  if (p?.decisionId === "budget") return opts.find((o) => o.id === "stop")?.id ?? null;
  if (p?.kind === "secret") return opts.find((o) => o.id === "test")?.id ?? null;
  const keep = opts.filter((o) => !AVOID_CHOICES.has(o.id));
  return (keep.find((o) => o.recommended) ?? keep[0] ?? opts[0])?.id ?? null;
}

/** A short answer to a free question of the orchestrator, from the brief (≤ 500 characters, postMessage). */
export function freeAnswer(brief) {
  const base = String(brief.free_answer ?? "Всё, что знаю, написал в описании")
    .trim()
    .replace(/[.\s]+$/u, "");
  return `${base}. Остальное решите сами, по своим рекомендациям.`.slice(0, 500);
}

/**
 * GateReport[] of getLatestGates → per level {passed, revision, blockers, ownerActions, warnings}. `beforePublish` —
 * reports of the build (the publication did not start): OWNER_INPUT_CHECKS count as owner actions too.
 */
export function summarizeGates(latest, { beforePublish = false } = {}) {
  const owner = (id) => OWNER_ACTION_CHECKS.has(id) || (beforePublish && OWNER_INPUT_CHECKS.has(id));
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
      blockers: failed.filter((c) => !owner(c.id)).map(line),
      ownerActions: failed.filter((c) => owner(c.id)).map(line),
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

/**
 * D76 coverage of a system plan (modules.yaml#system_plan): covered — no custom part and nothing out of scope;
 * uncovered — otherwise; unknown — the plan was not read (a v1 system or no plan API).
 */
export function planCoverage(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.modules))
    return { coverage: "unknown", modules: [], custom: [], outOfScope: [] };
  const custom = (Array.isArray(plan.custom) ? plan.custom : []).map((c) => String(c?.title ?? c?.id ?? "").slice(0, 200));
  const outOfScope = (Array.isArray(plan.outOfScope) ? plan.outOfScope : []).map((o) =>
    typeof o === "string"
      ? { what: o.slice(0, 200), replacement: null }
      : {
          // SystemPlan.outOfScope (appspec plan.ts): {request, replacement, category}.
          what: String(o?.request ?? o?.what ?? o?.title ?? "").slice(0, 200),
          replacement: o?.replacement ? String(o.replacement).slice(0, 200) : null,
        },
  );
  return {
    coverage: custom.length === 0 && outOfScope.length === 0 ? "covered" : "uncovered",
    modules: plan.modules.map((m) => String(m?.id ?? "")).filter(Boolean),
    custom,
    outOfScope,
  };
}

/** Stock providers of design.photos (appspec STOCK_PROVIDERS, D61). */
export const PHOTO_PROVIDERS = ["pexels", "pixabay"];

/**
 * Stock photos of a system plan (B2-41): design.photos counted by provider — {total, pexels, pixabay}; null when the
 * plan was not read. Counts only (no authors or links reach the report).
 */
export function photoCount(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.modules)) return null;
  const list = Array.isArray(plan.design?.photos) ? plan.design.photos : [];
  const out = { total: list.length };
  for (const p of PHOTO_PROVIDERS) out[p] = list.filter((x) => x?.provider === p).length;
  return out;
}

/**
 * SystemPlan of a plan document: getSystemPlan answers {plan: SystemPlanRevision} whose `plan` is the SystemPlan
 * (api.yaml, routes/plans.ts toPlanRevision); a bare SystemPlan passes as it is.
 */
export function unwrapPlan(x) {
  let p = x;
  for (let i = 0; i < 3 && p && typeof p === "object" && !Array.isArray(p.modules); i++) p = p.plan;
  return p && typeof p === "object" && Array.isArray(p.modules) ? p : null;
}

/**
 * The approved plan of a system: GET /systems/:id (field plan, B2-20) or GET /systems/:id/plan; null when the platform
 * has none (v1 pipeline).
 */
export async function readPlan(client, systemId, view) {
  const inline = unwrapPlan(view?.plan ?? view?.system?.plan);
  if (inline) return inline;
  try {
    return unwrapPlan((await client.get(`/systems/${systemId}/plan`)).body);
  } catch {
    return null;
  }
}

/** The plan revision awaiting approval after the goal interview (modules pipeline, B2-20); null when there is none. */
export async function pendingPlan(client, systemId) {
  try {
    const rev = (await client.get(`/systems/${systemId}/plan`)).body?.plan;
    return rev?.status === "awaiting_approval" && Number.isInteger(rev.revision) && unwrapPlan(rev)
      ? rev
      : null;
  } catch {
    return null;
  }
}

/**
 * Browser checks of the latest G1 (gates.yaml#G1.browser): goal scenarios G1-GOAL-<id> and G1-MOBILE-01. ran — the
 * checks are in the report at all (a v2 system without them is not ready under D76).
 */
export function browserSummary(latest) {
  const g1 = (latest?.reports ?? []).find((r) => r.level === "G1");
  const checks = g1?.checks ?? [];
  const goals = checks.filter((c) => String(c.id).startsWith("G1-GOAL-"));
  const mobile = checks.filter((c) => c.id === "G1-MOBILE-01");
  const bad = (c) => c.status === "fail" || c.status === "error";
  return {
    ran: mobile.length > 0,
    goals: {
      total: goals.length,
      passed: goals.filter((c) => c.status === "pass").length,
      failed: goals.filter(bad).map((c) => ({ id: c.id.slice("G1-GOAL-".length), message: String(c.message_ru ?? "").slice(0, 300) })),
    },
    mobile: mobile.length === 0 ? "absent" : mobile.some(bad) ? "fail" : "pass",
  };
}

/** D76 «готова»: G0–G2 without blockers (as D67) and the browser checks ran and passed. */
export function isReadyD76(gates, g2Mode, browser) {
  return isReady(gates, g2Mode) && !!browser?.ran && browser.mobile === "pass" && browser.goals.failed.length === 0;
}

/** D76 verdict of one brief without database facts (the driver's fail-fast; report.mjs refines it with the gaps table). */
export function countedD76(r) {
  if (r.plan?.coverage === "covered") return r.ready;
  // Out of scope items are written to «Запросы на развитие» by the platform itself when the plan is approved
  // (recordPlanOutOfScope, B2-41), so an uncovered brief that reached a working system is counted here; the report
  // re-checks the recorded requests in the database (report.mjs, countedVia gap_recorded).
  if (r.plan?.coverage === "uncovered") return r.ready;
  return false;
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
    pipeline: null,
    error: null,
    interview: { turns: 0, buttons: 0, free: 0, retries: 0 },
    card: null,
    build: null,
    fixes: 0,
    inputs: [],
    publish: null,
    gates: {},
    gaps: { outOfScope: [], reported: [], mentions: [] },
    plan: null,
    photos: null,
    browser: null,
    screenshots: [],
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
    ctx.onUpdate?.();
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
      // Stop of the whole measurement (fail-fast or a cancelled job): the run is cancelled, nothing more is spent.
      if (ctx.signal?.aborted) {
        await client.post(`/runs/${run.id}/cancel`).catch(() => {});
        throw new Error(`замер остановлен: ${ctx.signal.reason ?? "отмена"} — прогон ${phase} отменён`);
      }
      if (r.costRubEstimate > (ctx.maxBriefRub ?? DEFAULTS.maxBriefRub)) {
        await client.post(`/runs/${run.id}/cancel`).catch(() => {});
        throw new Error(
          `потолок брифа ${ctx.maxBriefRub ?? DEFAULTS.maxBriefRub} ₽ исчерпан (≈ ${Math.round(r.costRubEstimate)} ₽) — прогон ${phase} отменён`,
        );
      }
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
    const created = (
      await client.post("/systems", { prompt: brief.text, ...(ctx.orgId ? { orgId: ctx.orgId } : {}) })
    ).body;
    r.systemId = created.system.id;
    say(`система ${r.systemId}, интервью`);
    let run = await waitRun(created.run, "interview");
    let card = null;
    let planRev = null;
    // The client's last text in the chat: «Повторить» of the cabinet sends it again (Workspace.tsx retryText).
    let lastText = brief.text;
    let turnRetries = 0;
    const answerPending = async (pending) => {
      const answers = pending
        .map((q) => ({ q, o: pickOption(q) }))
        .filter((x) => x.o)
        .map(({ q, o }) => ({ questionId: q.id, optionId: o.id }));
      r.interview.buttons += answers.length;
      const a = await client.post(`/systems/${r.systemId}/answers`, { answers, restByRecommendation: true });
      return waitRun(a.body.run, "interview");
    };
    for (;;) {
      r.interview.turns += 1;
      if (run.status !== "succeeded") {
        // B2-41: a retryable failure of an interview or plan turn — the driver repeats the turn once, like the client's
        // «Повторить»: the open questions are answered again, else the last text is sent again.
        if (run.failure?.retryable && turnRetries < MAX_TURN_RETRIES) {
          turnRetries += 1;
          r.interview.retries += 1;
          say(`ход интервью не удался (${failure(run)}) — повтор хода, как сделал бы клиент`);
          const s = (await client.get(`/systems/${r.systemId}`)).body;
          const pending = Array.isArray(s.pendingQuestions) ? s.pendingQuestions : [];
          if (pending.length > 0) run = await answerPending(pending);
          else {
            const m = await client.post(`/systems/${r.systemId}/messages`, { text: lastText });
            run = await waitRun(m.body.run, "interview");
          }
          continue;
        }
        r.status = "interview_failed";
        r.error = `интервью: ${failure(run)}`;
        return r;
      }
      turnRetries = 0;
      const s = (await client.get(`/systems/${r.systemId}`)).body;
      if (s.pipeline) r.pipeline = s.pipeline;
      // Beta v2 (modules pipeline, B2-20): the goal interview ends with a system plan awaiting approval, not a card.
      if (s.system.stage === "card" && (s.pipeline === "modules" || !s.card)) {
        planRev = await pendingPlan(client, r.systemId);
        if (planRev) break;
      }
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
      if (pending.length > 0) run = await answerPending(pending);
      else if (s.system.stage === "interview") {
        r.interview.free += 1;
        lastText = freeAnswer(brief);
        const m = await client.post(`/systems/${r.systemId}/messages`, { text: lastText });
        run = await waitRun(m.body.run, "interview");
      } else {
        r.status = "interview_failed";
        r.error = `после интервью система на этапе «${s.system.stage}», карточки нет`;
        return r;
      }
    }
    let ap;
    const buildStart = now();
    if (planRev) {
      // The plan as the client sees it on the canvas, approved as it is (approveSystemPlan starts the build).
      const plan = unwrapPlan(planRev);
      r.plan = planCoverage(plan);
      r.card = {
        planRevision: planRev.revision,
        title: plan.niche ?? null,
        capCredits: null,
        outOfScope: r.plan.outOfScope.map((o) => (o.replacement ? `${o.what} — ${o.replacement}` : o.what)),
      };
      r.gaps.outOfScope = r.card.outOfScope;
      say(`план v${planRev.revision} утверждён (модули: ${r.plan.modules.join(", ")}), сборка`);
      ap = await client.post(`/systems/${r.systemId}/plan/approve`, { revision: planRev.revision });
    } else {
      r.card = {
        cardVersion: card.cardVersion,
        title: card.title ?? null,
        capCredits: card.cap?.credits ?? null,
        outOfScope: Array.isArray(card.outOfScope) ? card.outOfScope.map((x) => String(x).slice(0, 300)) : [],
      };
      r.gaps.outOfScope = r.card.outOfScope;
      say(`карточка v${card.cardVersion} одобрена, сборка`);
      ap = await client.post(`/systems/${r.systemId}/card/approve`, { cardVersion: card.cardVersion });
    }

    // Build (+ one «Исправить» per fixAttempts when checks failed).
    let build = await waitRun(ap.body.run, "build");
    // The G1 of the build carries the browser checks; the publish run's G1 (pilot G2 probe) may run without them.
    let buildLatest = await latestGates();
    let gates = summarizeGates(buildLatest);
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
      buildLatest = await latestGates();
      gates = summarizeGates(buildLatest);
    }
    const end = now();
    r.build = { status: build.status, ...(build.failure ? { failure: build.failure } : {}) };
    r.buildMinutes = minutesBetween(buildStart, end);
    r.minutes = minutesBetween(new Date(r.startedAt), end);

    // G2: the first publication (on the pilot it stops at the founder's review after G0–G2).
    if (ctx.g2 === "publish" && gates.G0?.passed && gates.G1?.passed) {
      r.publish = await probeG2(ctx, r, waitRun, say);
      gates = summarizeGates(await latestGates());
    } else {
      r.publish = { status: ctx.g2 === "publish" ? "not_publishable" : "skipped" };
      // B2-41: the build's G2 never has the owner's operator data — the cause is G0/G1 (mvp-01 of the D76 probe).
      gates = summarizeGates(buildLatest, { beforePublish: true });
    }
    r.gates = gates;
    if (ctx.threshold === "d76") {
      const after = browserSummary(await latestGates());
      r.browser = after.ran ? after : browserSummary(buildLatest);
      const built = await readPlan(client, r.systemId, (await client.get(`/systems/${r.systemId}`)).body);
      const read = planCoverage(built);
      if (read.coverage !== "unknown" || !r.plan) r.plan = read;
      // B2-41: stock photos of the plan as the API gives it (the report prefers the built plan of collectSql).
      r.photos = photoCount(built);
      r.ready = isReadyD76(gates, ctx.g2, r.browser);
    } else r.ready = isReady(gates, ctx.g2);
    r.status = r.ready
      ? "ready"
      : build.status !== "succeeded" && !gates.G0?.passed
        ? "build_failed"
        : "not_ready";
    say(r.ready ? `готова к публикации (${r.minutes} мин)` : `не готова: ${r.status}`);
  } catch (e) {
    r.status = r.status === "running" ? "error" : r.status;
    r.error = String(e?.message ?? e).slice(0, 500);
    say(`ошибка: ${r.error}`);
    // The platform's daily model cap (D75): no other brief can start today, the run stops instead of failing each.
    if (e?.code === "LLM_BUDGET_EXHAUSTED") ctx.abortRun?.("дневной лимит платформы на модели исчерпан");
  } finally {
    // Honest answers of the agents («Пока не умеем…», payload.gaps of chat messages, M2-77) — also after a failure.
    if (r.systemId)
      await collectGaps(client, r)
        .then((g) => Object.assign(r.gaps, g))
        .catch((e) => say(`пробелы не прочитаны: ${e?.message ?? e}`));
    // Screenshots of the system for the report grid (B2-41: the sites of the measurement side by side).
    if (r.systemId && ctx.screenshot)
      await Promise.resolve(ctx.screenshot(r))
        .then((shots) => {
          r.screenshots = (Array.isArray(shots) ? shots : []).slice(0, 4);
        })
        .catch((e) => say(`скриншоты не сняты: ${e?.message ?? e}`));
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
    return {
      ...out,
      status: "refused",
      code: e?.code ?? null,
      message: String(e?.message ?? e).slice(0, 300),
    };
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

/**
 * Capability gaps the agents reported in the chat: payload.gaps of assistant messages ({category, missing, offered},
 * deduplicated), and for a beyond brief the assistant texts that speak about its stems.
 */
export async function collectGaps(client, r) {
  const msgs = (await client.get(`/systems/${r.systemId}/messages?limit=100`)).body.items ?? [];
  const assistant = msgs.filter((m) => m.role === "assistant");
  const reported = [];
  const seen = new Set();
  for (const m of assistant)
    for (const g of Array.isArray(m.payload?.gaps) ? m.payload.gaps : []) {
      const key = `${g.category}|${g.missing}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reported.push({
        category: typeof g.category === "string" ? g.category : null,
        missing: String(g.missing ?? "").slice(0, 300),
        offered: g.offered ? String(g.offered).slice(0, 300) : null,
      });
    }
  const low = (r.beyond?.gapStems ?? []).map((s) => s.toLowerCase());
  const mentions = low.length
    ? assistant
        .map((m) => (typeof m.text === "string" ? m.text : ""))
        .filter((t) => low.some((s) => t.toLowerCase().includes(s)))
        .map((t) => t.slice(0, 300))
        .slice(0, 3)
    : [];
  return { reported, mentions };
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
  // Fail-fast (budget guard): once the D67 threshold cannot be reached any more, the rest is not worth the spend.
  const stop = new AbortController();
  const outer = o.signal;
  if (outer) {
    if (outer.aborted) stop.abort(outer.reason);
    else outer.addEventListener("abort", () => stop.abort(outer.reason), { once: true });
  }
  ctx.signal = stop.signal;
  const strict = ctx.threshold === "d76";
  const counted = o.counted ?? (strict ? countedD76 : (r) => r.ready);
  // D76 is strict: every brief counts, the first one lost makes the threshold unreachable.
  const need = strict ? results.length : Math.ceil((D67_THRESHOLD.ready / D67_THRESHOLD.of) * results.length);
  // A partial run (a probe of a few briefs, D75 step 2) drives every brief: its point is the diagnosis of each one.
  const failFast = o.failFast ?? results.length >= D67_THRESHOLD.of;
  ctx.abortRun = (reason) => {
    if (!stop.signal.aborted) stop.abort(reason);
  };
  // D76 (B2-41): the budget of the measurement is a hard stop — a running brief that takes the spend over it is
  // cancelled at once (D67 only stops new briefs from starting).
  if (strict)
    ctx.onSpend = () => {
      if (!stop.signal.aborted && spent() > ctx.maxCostRub)
        stop.abort(`бюджет замера ${ctx.maxCostRub} ₽ исчерпан (≈ ${Math.round(spent())} ₽ по кредитам)`);
    };
  const checkReachable = () => {
    if (!failFast || stop.signal.aborted) return;
    const lost = results.filter((x) => FINAL.has(x.status) && !counted(x)).length;
    if (results.length - lost < need)
      stop.abort(`порог ${need} из ${results.length} уже недостижим (не готовы: ${lost})`);
  };
  const update = ctx.onUpdate;
  ctx.onUpdate = () => update?.(results);
  const startedAt = ctx.now().toISOString();
  let next = 0;
  let peak = 0;
  let active = 0;
  async function worker() {
    while (next < o.briefs.length) {
      const i = next++;
      const r = results[i];
      if (stop.signal.aborted) {
        r.status = "skipped";
        r.error = `замер остановлен до старта: ${stop.signal.reason}`;
        ctx.log(`${r.id}: пропущен — ${r.error}`);
        ctx.onUpdate();
        continue;
      }
      if (spent() >= ctx.maxCostRub) {
        r.status = "skipped";
        r.error = `бюджет замера ${ctx.maxCostRub} ₽ исчерпан до старта`;
        ctx.log(`${r.id}: пропущен — бюджет исчерпан`);
        ctx.onUpdate();
        continue;
      }
      active += 1;
      peak = Math.max(peak, active);
      try {
        await driveBrief(ctx, o.briefs[i], r);
      } finally {
        active -= 1;
        const before = stop.signal.aborted;
        checkReachable();
        if (!before && stop.signal.aborted)
          ctx.log(`::warning title=${strict ? "D76" : "D67"}::замер остановлен: ${stop.signal.reason}`);
        ctx.onUpdate();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, ctx.concurrency) }, worker));
  return {
    kind: strict ? "d76" : "d67",
    threshold: ctx.threshold,
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
    failFast,
    stopped: stop.signal.aborted ? String(stop.signal.reason ?? "отмена") : null,
    results,
  };
}
