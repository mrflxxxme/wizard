// A fake platform-api for the D67 driver tests: the cabinet routes the driver uses (api.yaml), with the session cookie,
// CSRF and Origin checks of apps/platform-api/src/http/auth.ts. Scenarios are picked by words of the brief text.
// handler(Request) → Response, so it serves both a node:http server and an injected fetch.
import { createHash } from "node:crypto";

const sha256 = (v) => createHash("sha256").update(String(v ?? ""), "utf8").digest("hex");

const CREDITS = { interview_turn: 0.5, build: 40, fix: 10, publish: 0 };

/** Scenario of a brief by its text (the D67 set, tools/eval/briefs/mvp-*.json). */
export function scenarioOf(prompt) {
  const s = {
    freeQuestion: /переговорк/i.test(prompt),
    escalation: /CRM/.test(prompt),
    g1FailsFirst: /CRM/.test(prompt),
    g1AlwaysFails: /мастерской/i.test(prompt),
    secretOwnerAction: /Казани/.test(prompt),
    complianceNeeded: /библиотеки/i.test(prompt),
    buildFails: /йоги/i.test(prompt),
    outOfScope: /йоги/i.test(prompt)
      ? ["Оплата картой с автоплатежом и платная подписка пока недоступны — сделаем доступ к урокам по приглашению владельца"]
      : [],
    credits: { ...CREDITS },
  };
  return s;
}

const gate = (level, failed = []) => ({
  level,
  passed: failed.every((c) => c.severity !== "blocker"),
  checks: [
    { id: `${level}-OK-01`, status: "pass", severity: "blocker", message_ru: "Проверка пройдена" },
    ...failed.map((c) => ({ status: "fail", ...c })),
  ],
});

/**
 * `token`/`csrf` — the raw session values; or `hashes()` → {tokenHash, csrfHash} when only the database side is known
 * (the pilot action generates the token itself, as the operator does).
 */
export function fakePlatform({ token, csrf, hashes, origin, cookieNames, override = () => undefined }) {
  const st = { systems: new Map(), runs: new Map(), requests: [], tokens: new Set(), logout: 0, inFlight: 0, peak: 0 };
  let n = 0;
  const id = (p) => {
    n += 1;
    return `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status, code, message_ru = code) => json({ code, message_ru }, status);

  function newRun(sys, kind, mode, extra = {}) {
    const run = {
      id: id("a"),
      systemId: sys.id,
      kind,
      ...(mode ? { mode } : {}),
      status: "running",
      polls: 1,
      credits: { used: 0 },
      failure: null,
      events: [],
      after: () => {},
      ...extra,
    };
    st.runs.set(run.id, run);
    sys.activeRuns += 1;
    st.inFlight = [...st.systems.values()].filter((x) => x.activeRuns > 0).length;
    st.peak = Math.max(st.peak, st.inFlight);
    return run;
  }
  const event = (run, type, payload) => run.events.push({ runId: run.id, seq: run.events.length + 1, type, payload });
  function finish(run, status, failure = null) {
    run.status = status;
    run.failure = failure;
    run.credits.used = run.used;
    event(run, status === "succeeded" ? "run_finished" : "run_failed", failure ?? { status });
    const sys = st.systems.get(run.systemId);
    sys.activeRuns -= 1;
    run.after();
  }
  const view = (run) => {
    const { events: _e, after: _a, polls: _p, used: _u, ask: _k, ...rest } = run;
    return rest;
  };
  /** Advances a run one poll: running → (needs_input) → terminal. */
  function tick(run) {
    if (run.status !== "running") return;
    if (run.polls > 0) {
      run.polls -= 1;
      return;
    }
    if (run.ask && !run.asked) {
      run.asked = true;
      run.status = "needs_input";
      event(run, "needs_input", run.ask);
      return;
    }
    run.finishWith();
  }

  function interviewTurn(sys, trigger) {
    const sc = sys.sc;
    const run = newRun(sys, "interview_turn", null, { used: sc.credits.interview_turn });
    run.finishWith = () => {
      sys.turns += 1;
      if (sc.freeQuestion && trigger === "create") {
        sys.stage = "interview";
        sys.pending = [];
        sys.messages.push({ role: "assistant", kind: "text", text: "Сколько переговорных и с какого часа бронь?" });
      } else if (trigger === "create") {
        sys.pending = [
          {
            id: "q1",
            forkId: "notify_channel",
            text: "Куда присылать заявки?",
            whyItMatters: "От этого зависит уведомление",
            options: [
              { id: "email", label: "На почту", recommended: false },
              { id: "email_tg", label: "Почта и Telegram", recommended: true },
            ],
          },
          {
            id: "q2",
            forkId: "login",
            text: "Нужен ли вход посетителям?",
            whyItMatters: "Вход усложняет заявку",
            options: [
              { id: "no_login", label: "Без входа" },
              { id: "login", label: "Со входом" },
            ],
          },
        ];
        sys.messages.push({ role: "assistant", kind: "questions", text: "Пара вопросов" });
      } else {
        sys.pending = [];
        sys.stage = "card";
        sys.card = {
          cardVersion: 1,
          title: "Система",
          summary: "Черновик",
          cap: { credits: 60 },
          estimate: { credits: { expected: 30 } },
          outOfScope: sc.outOfScope,
        };
        if (sc.outOfScope.length)
          sys.messages.push({ role: "assistant", kind: "text", text: `Пока не умею: ${sc.outOfScope[0]}` });
      }
      finish(run, "succeeded");
    };
    return run;
  }

  function buildRun(sys, mode) {
    const sc = sys.sc;
    const run = newRun(sys, "build", mode, { used: mode === "fix" ? sc.credits.fix : sc.credits.build, polls: 2 });
    if (sc.escalation && mode === "create")
      run.ask = {
        inputId: "esc-1",
        kind: "decision",
        decisionId: "escalation",
        prompt_ru: "Не получается",
        options: [
          { id: "retry", label: "Попробовать ещё раз" },
          { id: "simplify", label: "Упростить" },
          { id: "rollback", label: "Вернуть" },
          { id: "rephrase", label: "Объяснить", freeText: true },
        ],
      };
    run.finishWith = () => {
      sys.builds += 1;
      if (sc.buildFails) {
        sys.stage = "failed";
        sys.gates.G0 = gate("G0", [{ id: "G0-TS-01", severity: "blocker", message_ru: "Код не собирается" }]);
        return finish(run, "failed", { code: "GATES_FAILED", message_ru: "Сборка не прошла проверки" });
      }
      sys.revision += 1;
      sys.stage = "ready";
      sys.gates.G0 = gate("G0");
      const g1fail = sc.g1AlwaysFails || (sc.g1FailsFirst && mode === "create");
      sys.gates.G1 = gate(
        "G1",
        g1fail ? [{ id: "G1-AC-02", severity: "blocker", message_ru: "Менеджер видит чужие сделки" }] : [],
      );
      finish(run, "succeeded");
    };
    return run;
  }

  function publishRun(sys) {
    const sc = sys.sc;
    const run = newRun(sys, "publish", null, { used: 0 });
    run.finishWith = () => {
      sys.gates.G2 = gate(
        "G2",
        sc.secretOwnerAction
          ? [{ id: "G2-SECRET-02", severity: "blocker", message_ru: "Не задан секрет telegram_bot для prod" }]
          : [],
      );
      if (!sys.gates.G2.passed)
        return finish(run, "failed", { code: "GATES_FAILED", message_ru: "Ревизия не прошла G2" });
      sys.review = "pending";
      finish(run, "failed", { code: "GATES_FAILED", message_ru: "Перед публикацией систему посмотрит модератор" });
    };
    return run;
  }

  const blockers = (sys) => {
    const out = [];
    if (sys.sc.complianceNeeded && !sys.compliance) out.push("OPERATOR_NAME_REQUIRED");
    if (!sys.gates.G0?.passed || !sys.gates.G1?.passed) out.push("GATES_FAILED");
    if (sys.review === "pending") out.push("FOUNDER_REVIEW_PENDING");
    return out;
  };
  const sysView = (sys) => ({
    id: sys.id,
    orgId: sys.orgId,
    stage: sys.stage,
    draftRevision: sys.revision,
    previewRevision: sys.revision || null,
    prodRevision: null,
  });

  async function handler(req) {
    const u = new URL(req.url);
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const method = req.method;
    st.requests.push(`${method} ${path}`);
    const jar = Object.fromEntries(
      (req.headers.get("cookie") ?? "")
        .split(";")
        .map((x) => x.trim().split("="))
        .filter((x) => x.length === 2),
    );
    const sessionOk = hashes ? sha256(jar[cookieNames.session]) === hashes().tokenHash : jar[cookieNames.session] === token;
    if (!sessionOk || st.logout > 0) return err(401, "UNAUTHENTICATED");
    st.tokens.add(jar[cookieNames.session]);
    if (method !== "GET") {
      if (req.headers.get("origin") !== origin) return err(403, "FORBIDDEN", "Origin");
      const header = req.headers.get("x-wizard-csrf");
      const csrfOk = hashes ? sha256(header) === hashes().csrfHash : header === csrf;
      if (!csrfOk || header !== jar[cookieNames.csrf]) return err(403, "FORBIDDEN", "CSRF");
      st.tokens.add(header);
    }
    const body = method === "GET" ? null : await req.text().then((t) => (t ? JSON.parse(t) : {}));
    const o = override(method, path, body);
    if (o) return o;
    let m;
    if (method === "POST" && path === "/auth/logout") {
      st.logout += 1;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/systems") {
      const sys = {
        id: id("s"),
        orgId: body.orgId,
        prompt: body.prompt,
        sc: scenarioOf(body.prompt),
        stage: "interview",
        pending: [],
        messages: [{ role: "user", kind: "text", text: body.prompt }],
        card: null,
        revision: 0,
        gates: {},
        turns: 0,
        builds: 0,
        activeRuns: 0,
        compliance: null,
        review: null,
      };
      st.systems.set(sys.id, sys);
      const run = interviewTurn(sys, "create");
      return json({ system: sysView(sys), run: view(run) }, 201);
    }
    if ((m = /^\/runs\/([^/]+)$/.exec(path)) && method === "GET") {
      const run = st.runs.get(m[1]);
      if (!run) return err(404, "NOT_FOUND");
      tick(run);
      return json(view(run));
    }
    if ((m = /^\/runs\/([^/]+)\/events$/.exec(path))) {
      const run = st.runs.get(m[1]);
      const after = Number(u.searchParams.get("after") ?? 0);
      const text = `: ping\n\n${run.events
        .filter((e) => e.seq > after)
        .map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e, ts: "2026-10-05T10:00:00Z" })}\n\n`)
        .join("")}`;
      // Two chunks split inside a frame: the client must reassemble.
      const enc = new TextEncoder();
      const cut = Math.floor(text.length / 2);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(text.slice(0, cut)));
          c.enqueue(enc.encode(text.slice(cut)));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if ((m = /^\/runs\/([^/]+)\/input$/.exec(path)) && method === "POST") {
      const run = st.runs.get(m[1]);
      if (run.status !== "needs_input" || body.inputId !== run.ask.inputId) return err(409, "NO_INPUT");
      run.choice = body.choice;
      event(run, "input_received", { inputId: body.inputId, choice: body.choice });
      run.status = "running";
      return json(view(run), 202);
    }
    if ((m = /^\/runs\/([^/]+)\/cancel$/.exec(path)) && method === "POST") {
      const run = st.runs.get(m[1]);
      if (run.status === "running" || run.status === "needs_input") finish(run, "cancelled");
      return json(view(run), 202);
    }
    m = /^\/systems\/([^/]+)(\/.*)?$/.exec(path);
    const sys = m && st.systems.get(m[1]);
    if (!sys) return err(404, "NOT_FOUND");
    const sub = m[2] ?? "";
    if (method === "GET" && sub === "")
      return json({
        system: sysView(sys),
        card: sys.card,
        pendingQuestions: sys.pending,
        messages: sys.messages,
        activeRunId: null,
        publishBlockers: blockers(sys),
      });
    if (method === "GET" && sub.startsWith("/messages"))
      return json({ items: sys.messages.map((x, i) => ({ id: `m${i}`, seq: i + 1, ...x })) });
    if (method === "POST" && sub === "/answers") {
      if (!sys.pending.length) return err(400, "VALIDATION_FAILED", "Нет вопросов");
      for (const a of body.answers ?? []) {
        const q = sys.pending.find((x) => x.id === a.questionId);
        if (!q || !q.options.some((x) => x.id === a.optionId)) return err(400, "VALIDATION_FAILED", "ответ");
      }
      sys.answers = body.answers;
      return json({ run: view(interviewTurn(sys, "answers")) }, 202);
    }
    if (method === "POST" && sub === "/messages") {
      sys.messages.push({ role: "user", kind: "text", text: body.text });
      return json({ message: {}, run: view(interviewTurn(sys, "message")) }, 202);
    }
    if (method === "POST" && sub === "/card/approve") {
      if (sys.stage !== "card" || body.cardVersion !== sys.card.cardVersion) return err(409, "NO_CARD");
      sys.stage = "building";
      return json({ run: view(buildRun(sys, "create")) }, 202);
    }
    if (method === "POST" && sub === "/fix") {
      const failed = Object.values(sys.gates).some((g) => !g.passed);
      if (!failed) return err(409, "NO_GATE_FAILURE", "Исправлять нечего");
      sys.stage = "building";
      return json({ run: view(buildRun(sys, "fix")) }, 202);
    }
    if (method === "GET" && sub === "/gates/latest")
      return json({ revision: sys.revision, reports: Object.values(sys.gates) });
    if (method === "PUT" && sub === "/compliance") {
      if (body.expectedVersion !== sys.revision) return err(409, "VERSION_CONFLICT");
      if (!body.operatorName || !/@/.test(body.operatorContact ?? "")) return err(400, "VALIDATION_FAILED");
      sys.compliance = body;
      sys.revision += 1;
      return json({ revision: { version: sys.revision } });
    }
    if (method === "POST" && sub === "/publish") {
      if (sys.review === "pending") return err(409, "FOUNDER_REVIEW_PENDING");
      if (body.revision !== sys.revision) return err(400, "VALIDATION_FAILED", "ревизия");
      if (blockers(sys).length) return err(409, blockers(sys)[0]);
      return json({ run: view(publishRun(sys)) }, 202);
    }
    return err(404, "NOT_FOUND");
  }
  return { st, handler };
}
