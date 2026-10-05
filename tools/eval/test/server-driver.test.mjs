// M2-88 (mvp_scope, D67): the measurement driver against a fake platform over real HTTP — interview with button and
// free questions, card, build with needs_input and «Исправить», the G2 probe by the first publication, the budget,
// the report and the CLI. The pilot action is tested in tools/deploy/test/pilot.test.mjs.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBriefs, MVP_SET } from "../lib/briefs.mjs";
import { main as cli, selectBriefs } from "../server/cli.mjs";
import { cookieNames, parseFrame, platformClient } from "../server/client.mjs";
import { freeAnswer, pickDecision, pickOption, runEval } from "../server/driver.mjs";
import { evaluate, median, renderReport } from "../server/report.mjs";
import { fakePlatform } from "./fake-platform.mjs";

const SESSION = { token: "t".repeat(43), csrf: "c".repeat(43) };
const tmp = mkdtempSync(join(tmpdir(), "wizard-d67-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** node:http server around the fake platform (Request/Response in between, streaming bodies included). */
async function serve(fake) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await fake.handler(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(body && req.method !== "GET" ? { body } : {}),
      }),
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

let srv;
/** What the server delegates to; each test installs its own fake (freshFake). */
const fake = { handler: async () => new Response(null, { status: 503 }), st: null };
beforeAll(async () => {
  srv = await serve(fake);
});
afterAll(() => srv?.server.close());

/** The fake checks Origin against the server's own origin (known after listen). */
function freshFake(over) {
  const f = fakePlatform({
    ...SESSION,
    origin: srv.base,
    cookieNames: cookieNames(srv.base),
    ...(over ? { override: over } : {}),
  });
  fake.handler = f.handler;
  fake.st = f.st;
  return f;
}
const quiet = { log: () => {}, sleep: async () => {}, pollMs: 1 };
const client = (session = SESSION) => platformClient({ base: srv.base, session, sleep: async () => {} });

describe("D67 brief set", () => {
  it("ten mvp-* briefs: 3 sites, 3 bookings, 2 CRM, 2 outside the classes; one beyond with gap stems", () => {
    const b = loadBriefs("mvp");
    expect(b).toHaveLength(MVP_SET.total);
    for (const c of ["site", "booking", "crm", "other"])
      expect(
        b.filter((x) => x.class === c),
        c,
      ).toHaveLength(MVP_SET[c]);
    expect(b.filter((x) => x.beyond).map((x) => x.id)).toEqual(["mvp-10-yoga-subscription"]);
    // The P set is untouched: mvp-* only by "mvp" or by id.
    expect(loadBriefs().some((x) => x.id.startsWith("mvp-"))).toBe(false);
    expect(selectBriefs("mvp-03,mvp-10").map((x) => x.id)).toEqual([
      "mvp-03-english-courses",
      "mvp-10-yoga-subscription",
    ]);
    expect(() => selectBriefs("mvp-99")).toThrow(/неизвестный бриф/);
  });

  it("client choices: recommended or first option; decisions keep the build going; secrets are never invented", () => {
    expect(pickOption({ options: [{ id: "a" }, { id: "b", recommended: true }] }).id).toBe("b");
    expect(pickOption({ options: [{ id: "a" }, { id: "b" }] }).id).toBe("a");
    expect(
      pickDecision({
        kind: "decision",
        options: [{ id: "stop" }, { id: "raise_cap_15", recommended: false }],
      }),
    ).toBe("raise_cap_15");
    expect(
      pickDecision({ kind: "decision", options: [{ id: "rephrase", freeText: true }, { id: "retry" }] }),
    ).toBe("retry");
    expect(pickDecision({ kind: "secret", options: [{ id: "test" }] })).toBe("test");
    expect(pickDecision({ kind: "secret", options: [] })).toBeNull();
    expect(freeAnswer({ free_answer: "Переговорка одна." })).toBe(
      "Переговорка одна. Остальное решите сами, по своим рекомендациям.",
    );
  });

  it("SSE frames: pings skipped, the envelope gives seq, type and payload", () => {
    expect(parseFrame(": ping")).toBeNull();
    expect(
      parseFrame('id: 3\nevent: needs_input\ndata: {"seq":3,"type":"needs_input","payload":{"inputId":"x"}}'),
    ).toEqual({ seq: 3, type: "needs_input", payload: { inputId: "x" } });
  });
});

describe("D67 driver on a fake platform", () => {
  it("ten briefs, two at a time: interview, card, build, fix, G2 probe — 9 of 10 count", async () => {
    const f = freshFake();
    const logs = [];
    const doc = await runEval({
      client: client(),
      briefs: loadBriefs("mvp"),
      orgId: "org-1",
      ownerEmail: "eval+20261005-abcdef@borntobuild.ru",
      runId: "20261005-abcdef",
      ...quiet,
      log: (s) => logs.push(s),
    });
    const by = Object.fromEntries(doc.results.map((r) => [r.id.slice(0, 6), r]));
    expect(doc.peakConcurrency).toBe(2);
    expect(f.st.peak).toBeLessThanOrEqual(2);
    // Button questions: the recommended option, else the first.
    const sys = [...f.st.systems.values()].find((s) => s.prompt.startsWith("Стоматология"));
    expect(sys.answers).toEqual([
      { questionId: "q1", optionId: "email_tg" },
      { questionId: "q2", optionId: "no_login" },
    ]);
    // Free question → a short answer from the brief.
    expect(by["mvp-06"].interview).toEqual({ turns: 2, buttons: 0, free: 1 });
    const room = [...f.st.systems.values()].find((s) => s.prompt.startsWith("аренда"));
    expect(room.messages.find((m) => m.role === "user" && m !== room.messages[0]).text).toContain(
      "Переговорка одна",
    );
    // Escalation answered «retry», failed G1 fixed by one «Исправить».
    expect(by["mvp-07"]).toMatchObject({ status: "ready", fixes: 1 });
    expect(by["mvp-07"].inputs).toEqual([{ kind: "decision", decisionId: "escalation", choice: "retry" }]);
    // G1 still failing after the fix: not ready, the check and its reason are kept.
    expect(by["mvp-08"]).toMatchObject({ status: "not_ready", ready: false, fixes: 1 });
    expect(by["mvp-08"].gates.G1.blockers).toEqual([
      { id: "G1-AC-02", message: "Менеджер видит чужие сделки" },
    ]);
    // Owner action in G2 (a prod secret) does not take readiness away.
    expect(by["mvp-01"]).toMatchObject({ status: "ready", publish: { status: "failed" } });
    expect(by["mvp-01"].gates.G2.ownerActions.map((c) => c.id)).toEqual(["G2-SECRET-02"]);
    // Operator data filled with test values before the publication; founder review then holds it.
    expect(by["mvp-09"].publish).toMatchObject({ status: "review_pending", complianceFilled: true });
    const lib = [...f.st.systems.values()].find((s) => s.prompt.includes("библиотеки"));
    expect(lib.compliance).toMatchObject({
      operatorName: "Тестовый оператор замера D67",
      operatorContact: "eval+20261005-abcdef@borntobuild.ru",
    });
    expect(by["mvp-02"]).toMatchObject({ status: "ready", publish: { status: "review_pending" } });
    // Beyond: build failed, but the honest answer is in the card and in the chat.
    expect(by["mvp-10"]).toMatchObject({ status: "build_failed", ready: false });
    expect(by["mvp-10"].gaps.outOfScope[0]).toContain("Оплата картой");
    expect(by["mvp-10"].gaps.mentions[0]).toContain("Пока не умеем: оплата картой");
    expect(by["mvp-10"].gaps.reported).toEqual([
      {
        category: "subscriptions",
        missing: "оплата картой каждый месяц и платная подписка",
        offered: "доступ к урокам по приглашению владельца",
      },
    ]);
    expect(by["mvp-02"].gaps.reported).toEqual([]);
    // Cost: credits of every run × 5 ₽.
    expect(by["mvp-02"].creditsUsed).toBe(41);
    expect(by["mvp-02"].costRubEstimate).toBe(205);
    expect(by["mvp-07"].creditsUsed).toBe(51);
    expect(doc.results.every((r) => r.minutes !== null)).toBe(true);
    const e = evaluate(doc);
    expect(e.ready).toBe(9);
    expect(e.passed).toBe(true);
    expect(e.items.find((x) => x.id.startsWith("mvp-10")).countedVia).toBe("gap_mentioned");
    expect(e.gaps).toBe(1);
    const { text } = renderReport(doc);
    expect(text).toContain("Пробелов возможностей («Пока не умеем…») назвали агенты: 1 — в брифах mvp-10");
    expect(text).toContain(
      "- Пока не умеем (subscriptions): оплата картой каждый месяц и платная подписка — замена: доступ к урокам по приглашению владельца",
    );
    expect(text).toMatch(/\| mvp-10-yoga-subscription \|.*\| 1 \| subscriptions \|/);
    expect(logs.join("\n")).not.toContain(SESSION.token);
  });

  it("budget: a brief starts only while the spend is below --max-cost-rub", async () => {
    freshFake();
    const doc = await runEval({
      client: client(),
      briefs: loadBriefs("mvp").slice(0, 4),
      maxCostRub: 300,
      concurrency: 1,
      g2: "skip",
      ...quiet,
    });
    expect(doc.results.map((r) => r.status)).toEqual(["ready", "ready", "skipped", "skipped"]);
    expect(doc.results[2].error).toContain("бюджет замера 300 ₽");
    expect(doc.g2).toBe("skip");
  });

  it("a secret the eval cannot give cancels the run; a refused session ends the brief with an error", async () => {
    const f = freshFake();
    // Give every build of this platform a secret request.
    const orig = f.handler;
    fake.handler = async (req) => {
      const res = await orig(req);
      for (const run of f.st.runs.values())
        if (run.kind === "build" && !run.ask)
          run.ask = { inputId: "sec-1", kind: "secret", secretName: "tg", prompt_ru: "Токен", options: [] };
      return res;
    };
    const doc = await runEval({ client: client(), briefs: loadBriefs("mvp").slice(1, 2), ...quiet });
    expect(doc.results[0].status).toBe("error");
    expect(doc.results[0].error).toContain("секрет");
    expect([...f.st.runs.values()].find((r) => r.kind === "build").status).toBe("cancelled");

    freshFake();
    const bad = await runEval({
      client: client({ token: SESSION.token, csrf: "x".repeat(43) }),
      briefs: loadBriefs("mvp").slice(0, 1),
      ...quiet,
    });
    expect(bad.results[0]).toMatchObject({ status: "error", systemId: null });
    expect(bad.results[0].error).toContain("403 FORBIDDEN");
  });
});

const doc = () => ({
  base: "https://borntobuild.ru",
  runId: "20261005-abcdef",
  startedAt: "2026-10-05T10:00:00.000Z",
  maxCostRub: 2000,
  concurrency: 2,
  g2: "publish",
  results: loadBriefs("mvp").map((b, i) => ({
    id: b.id,
    class: b.class,
    title: b.title,
    beyond: b.beyond ? { gapStems: b.beyond.gap_stems } : null,
    status: i < 6 ? "ready" : i === 9 ? "build_failed" : "not_ready",
    ready: i < 6,
    systemId: `00000000-0000-4000-8000-00000000000${i}`,
    error: null,
    interview: { turns: 2, buttons: 2, free: 0 },
    build: { status: "succeeded" },
    fixes: 0,
    inputs: [],
    publish: { status: i < 6 ? "review_pending" : "not_publishable" },
    gates: {
      G0: { passed: true, blockers: [], ownerActions: [], warnings: 0 },
      G1:
        i < 6
          ? { passed: true, blockers: [], ownerActions: [], warnings: 1 }
          : {
              passed: false,
              blockers: [{ id: "G1-AC-01", message: "Запись | на занятое время" }],
              ownerActions: [],
              warnings: 0,
            },
    },
    gaps: { outOfScope: i === 9 ? ["Подписка с автоплатежом пока недоступна"] : [], mentions: [] },
    runs: [],
    creditsUsed: 40,
    costRubEstimate: 200,
    minutes: 10 + i,
    buildMinutes: 8,
  })),
});

describe("D67 report", () => {
  it("6 ready + beyond recorded in «Запросы на развитие» = 7 of 10: the threshold is met; ₽ exact from the DB", () => {
    const d = doc();
    const db = {
      costs: Object.fromEntries(d.results.map((r) => [r.systemId, { rub: 150.5, credits: 31, calls: 12 }])),
      gaps: {
        [d.results[9].systemId]: [
          { category: "payments", quote: "оплата картой каждый месяц", offered: "доступ по приглашению" },
        ],
      },
    };
    const { text, summary } = renderReport(d, db);
    expect(summary).toMatchObject({
      ready: 7,
      total: 10,
      passed: true,
      medianMinutes: 14.5,
      costRub: 1505,
      costExact: true,
    });
    expect(text).toContain(
      "**Итог: 7 из 10 дошли до готовности к публикации — порог D67 (не меньше 7 из 10) достигнут.**",
    );
    expect(text).toContain("1 505 ₽ (точно, по журналу вызовов моделей)");
    expect(text).toContain("G1 · G1-AC-01");
    expect(text).toContain("  - G1-AC-01: Запись | на занятое время");
    expect(text).toContain(
      "Запрос на развитие: payments — оплата картой каждый месяц — замена: доступ по приглашению",
    );
    expect(text).toContain("честный отказ записан");
    expect(text).not.toContain("Раздел «Запросы на развитие» из базы прочитать не удалось");
  });

  it("without the gaps table and the DB costs: estimates, a provisional beyond, below the threshold", () => {
    const d = doc();
    d.results[5].ready = false;
    d.results[5].status = "not_ready";
    const { text, summary } = renderReport(d);
    expect(summary).toMatchObject({ ready: 6, passed: false, costRub: 2000, costExact: false });
    expect(text).toContain("не достигнут");
    expect(text).toContain("оценка по кредитам");
    expect(text).toContain("✅*");
    expect(text).toContain("Раздел «Запросы на развитие» из базы прочитать не удалось");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
    // No build_metrics in the DB: no stage lines.
    expect(text).not.toContain("Этапы:");
    expect(text).not.toContain("с первого хода");
  });

  it("stage metrics (build_metrics): a line per brief and the first-pass share across briefs in the header", () => {
    const d = doc();
    const stages = (tasks, firstPass, review) => ({
      brief: { tasks, retries: 0 },
      tasks: { total: tasks, firstPass, passed: tasks, failed: 0, calls: tasks + 2 },
      verify: { g0Runs: 2, g1Runs: 1, fixTasks: tasks - firstPass, fixPhases: 0 },
      review,
    });
    const db = {
      metrics: {
        [d.results[0].systemId]: { stages: stages(5, 4, { pages: 2, ok: 2, critical: 0, minor: 1, skipped: false }) },
        [d.results[1].systemId]: { stages: stages(1, 0, { pages: 0, ok: 0, critical: 0, minor: 0, skipped: true }) },
      },
    };
    const { text, summary } = renderReport(d, db);
    expect(summary.firstPass).toEqual({ briefs: 2, passed: 4, total: 6 });
    expect(text).toContain("- Задачи ТЗ, готовые с первого хода исполнителя: 4 из 6 (67 %) — по брифам с метриками этапов: 2");
    expect(text).toContain(
      "- Этапы: ТЗ — 5 задач; с первого хода — 4 из 5; исправления — 1; рецензент — ok 2, критично 0, мелочи 1.",
    );
    expect(text).toContain("- Этапы: ТЗ — 1 задача; с первого хода — 0 из 1; исправления — 1; рецензент — пропущен.");
    expect(text.match(/Этапы:/g)).toHaveLength(2);
  });
});

describe("D67 CLI", () => {
  it("seed: the raw token only in the 0600 session file, the SQL has its hash; report exits 1 below the threshold", async () => {
    const session = join(tmp, "s.json");
    let sql = "";
    const logs = [];
    await cli(["seed", "--session-file", session, "--runid", "20261005-abcdef"], {
      stdout: (s) => {
        sql += s;
      },
      log: (s) => logs.push(s),
    });
    const s = JSON.parse(readFileSync(session, "utf8"));
    expect(statSync(session).mode & 0o777).toBe(0o600);
    expect(s.email).toBe("eval+20261005-abcdef@borntobuild.ru");
    expect(sql).toContain(s.tokenHash);
    expect(sql).not.toContain(s.token);
    expect(sql).not.toContain(s.csrf);
    expect(sql).toContain("\\set credits_milli '900000'");
    expect(logs.join("\n")).not.toContain(s.token);
    let revoke = "";
    await cli(["cleanup", "--session-file", session], { stdout: (x) => (revoke += x), log: () => {} });
    expect(revoke).toContain(s.tokenHash);
    const results = join(tmp, "r.json");
    const d = doc();
    d.results.forEach((r) => {
      r.ready = false;
      r.status = "not_ready";
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(results, JSON.stringify(d));
    let md = "";
    expect(await cli(["report", "--results", results], { stdout: (x) => (md += x) })).toBe(1);
    expect(md).toContain("1 из 10");
  });
});
