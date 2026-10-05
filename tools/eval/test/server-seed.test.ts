// M2-88 (mvp_scope, D67): the seed SQL of the measurement account on a database migrated by platform-api — the
// session it stores (sha256 of token and CSRF) is accepted by apps/platform-api, the driver goes brief → card →
// build → G2 → founder review through the real routes (fake executors, no models), costs and «Запросы на развитие»
// are collected, and the revoke SQL ends the session. Needs psql (as the release operator uses it).
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createTestDb,
  fakeBuild,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
} from "../../../apps/platform-api/test/helpers.ts";
import { MemoryMailer, ORIGIN } from "../../../apps/platform-api/test/session.ts";
import { loadBriefs } from "../lib/briefs.mjs";
import { platformClient } from "../server/client.mjs";
import { runEval } from "../server/driver.mjs";
import { renderReport } from "../server/report.mjs";
import {
  collectSql,
  evalCredits,
  evalIdentity,
  newEvalSession,
  parseCollectOutput,
  parseSeedOutput,
  revokeSql,
  seedSql,
} from "../server/seed.mjs";

const hasPsql = spawnSync("psql", ["--version"]).status === 0;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout;
}

describe.skipIf(!hasPsql)("D67 seed on the platform database", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let api: TestApi;
  const runid = "20261005-a1b2c3";
  const session = newEvalSession();
  let seed: { userId: string; orgId: string; sessionId: string; email: string };

  beforeAll(async () => {
    tdb = await createTestDb("evalseed");
    api = await startApi(tdb.url, {
      // As on the pilot: sessions, invite-only registration, G2 at publication and the founder's review.
      config: {
        authMode: "session",
        registration: "invite",
        prodG2Required: true,
        founderReviewRequired: true,
        runConcurrency: 4,
      },
      mailer: new MemoryMailer(),
      creditsCronMs: 0,
      // The fake build asks an escalation (a client answers it) and runs G1 after G0, as the cluster build does.
      executors: {
        ...fakeExecutors({ spec: "forum" }),
        build: async (host, p) => {
          const out = await fakeBuild(host, p, { spec: "forum", askInput: true });
          await host.runGates("G1");
          return out;
        },
      },
      createRouter: fakeRouterFactory(),
      publish: { smoke: async () => ({ ok: true }), lockRetryDelaysMs: [10, 10, 10] },
    });
    seed = parseSeedOutput(
      psql(
        tdb.url,
        seedSql({
          runid,
          tokenHash: session.tokenHash,
          csrfHash: session.csrfHash,
          credits: evalCredits(2000),
        }),
      ),
    );
  });
  afterAll(async () => {
    await api?.dispose();
    await tdb?.drop();
  });

  const cookie = () => `wizard_session=${session.token}; wizard_csrf=${session.csrf}`;

  test("the seeded session is accepted: owner of a pilot org with credits, consents given, review on", async () => {
    expect(seed.email).toBe(evalIdentity(runid).email);
    const me = await api.req("GET", "/me", { headers: { cookie: cookie() } });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("eval+20261005-a1b2c3@borntobuild.ru");
    expect(me.body.memberships).toEqual([expect.objectContaining({ orgId: seed.orgId, role: "owner" })]);
    const [org] = await api.deps.pg`
      select name, plan, require_founder_review from platform.orgs where id = ${seed.orgId}`;
    expect(org).toEqual({ name: "Замер D67 · 20261005-a1b2c3", plan: "pilot", require_founder_review: true });
    const credits = await api.req("GET", `/orgs/${seed.orgId}/credits`, { headers: { cookie: cookie() } });
    expect(credits.status).toBe(200);
    expect(JSON.stringify(credits.body)).toContain("900");
    // The database has only hashes: neither the token nor the CSRF value.
    const rows = await api.deps
      .pg`select token_hash, csrf_hash from platform.sessions where id = ${seed.sessionId}`;
    expect(JSON.stringify(rows)).not.toContain(session.token);
    expect(rows[0]).toEqual({ token_hash: session.tokenHash, csrf_hash: session.csrfHash });
    // A mutating request without the CSRF header is refused, as for any client.
    const bad = await api.req("POST", "/systems", {
      body: { prompt: "Тест без CSRF" },
      headers: { cookie: cookie(), origin: ORIGIN },
    });
    expect(bad.status).toBe(403);
  });

  test("a second seed with the same run id fails without touching the first account", () => {
    expect(() =>
      psql(tdb.url, seedSql({ runid, tokenHash: "a".repeat(64), csrfHash: "b".repeat(64), credits: 10 })),
    ).toThrow(/duplicate key|unique/i);
  });

  test("the driver through the real routes: brief → card → build → G2 → founder review; collect; revoke", async () => {
    const client = platformClient({
      base: ORIGIN,
      session,
      fetch: (url: string, init: RequestInit) =>
        api.fetch(
          new Request(url, { ...init, headers: { ...(init.headers as object), host: "localhost:4000" } }),
        ),
      sleep: async () => {},
    });
    const doc = await runEval({
      client,
      briefs: loadBriefs("mvp-02-renovation"),
      orgId: seed.orgId,
      ownerEmail: seed.email,
      runId: runid,
      pollMs: 20,
      log: () => {},
    });
    const r = doc.results[0];
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ status: "ready", ready: true });
    expect(r.gates.G0.passed && r.gates.G1.passed && r.gates.G2.passed).toBe(true);
    expect(r.publish.status).toBe("review_pending");
    expect(r.inputs).toEqual([{ kind: "decision", decisionId: "escalation", choice: "retry" }]);
    expect(r.creditsUsed).toBeGreaterThan(0);
    // D70: the eval org has room for every brief (pilot limit raised as /admin does).
    const [org] = await api.deps.pg`select pilot_builds_limit from platform.orgs where id = ${seed.orgId}`;
    expect(org.pilot_builds_limit).toBe(15);

    // Nothing went live: the first publication waits for the founder.
    const [rev] = await api.deps.pg`
      select status from platform.founder_reviews where system_id = ${r.systemId}`;
    expect(rev.status).toBe("pending");

    // «Запросы на развитие» (M2-59, migration 0022): none yet → empty; a request of the org's system is collected.
    expect(parseCollectOutput(psql(tdb.url, collectSql({ orgId: seed.orgId }))).gaps).toEqual({});
    await api.deps.pg`insert into platform.development_requests (org_id, system_id, category, quote, offered)
      values (${seed.orgId}, ${r.systemId}, 'payments', 'оплата картой каждый месяц', 'доступ по приглашению'),
             (${seed.orgId}, ${r.systemId}, 'media', 'видео на странице', 'ссылка на видеохостинг')`;
    const db = parseCollectOutput(psql(tdb.url, collectSql({ orgId: seed.orgId })));
    expect(db.gaps).toEqual({
      [r.systemId as string]: [
        { category: "payments", quote: "оплата картой каждый месяц", offered: "доступ по приглашению" },
        { category: "media", quote: "видео на странице", offered: "ссылка на видеохостинг" },
      ],
    });
    expect(typeof db.costs).toBe("object");
    // Two systems with spend: json_agg of records splits the line between elements — it must stay one JSON line.
    for (const systemId of [r.systemId, null])
      await api.deps.pg`insert into platform.llm_calls (org_id, system_id, call_type, tier, provider, model_id,
          attempt, status, route_reason, policy_version, scrubbed, pii_categories_count, input_tokens, cached_tokens,
          output_tokens, tool_calls, cost_rub, credits_milli, billable, mode)
        values (${seed.orgId}, ${systemId}, 'interview', 'T1', 'zai', 'glm-5.3', 1, 'ok', 'default_T1', 'test', true,
          '{}'::jsonb, 100, 0, 100, 0, 1.5, 300, true, 'live')`;
    const spent = parseCollectOutput(psql(tdb.url, collectSql({ orgId: seed.orgId }))).costs;
    expect(spent[r.systemId as string]).toMatchObject({ rub: expect.any(Number), calls: expect.any(Number) });
    const { summary } = renderReport(doc, db);
    expect(summary.ready).toBe(1);

    expect(psql(tdb.url, revokeSql({ tokenHash: session.tokenHash }))).toContain(`revoked=${seed.sessionId}`);
    expect((await api.req("GET", "/me", { headers: { cookie: cookie() } })).status).toBe(401);
  });
});
