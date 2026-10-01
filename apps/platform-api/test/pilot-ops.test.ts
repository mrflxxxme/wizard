// Acceptance M2-09 (backlog: «Флаг requireFounderReview блокирует prod до одобрения», «Приглашение партнёра
// невозможно, пока M2-13 (beta_readiness) не done — флаг beta_readiness») plus the pilot leftovers of M2-15: founder
// review before the first prod publication and for new personal-data fields, the beta_readiness flag of the pilot CLI,
// platform mail over SMTP (local receiver in-process), run metrics and the run failure-rate founder alert, org creation
// and top-ups on the pilot plan.
import type { AppSpec } from "@wizard/appspec";
import { SmtpMock, testCert } from "@wizard/connectors/mocks";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { MailMessage } from "../src/auth/mailer.js";
import { platformMailer, SmtpMailer } from "../src/auth/smtp-mailer.js";
import { assertStartupAllowed, type Config, loadConfig, parseMailFrom } from "../src/config.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import { createOpsAlert, type OpsAlert } from "../src/ops/alert.js";
import { checkRunFailureRate } from "../src/ops/checks.js";
import { platformMetrics, startMetricsServer } from "../src/ops/metrics.js";
import { runPilotCli } from "../src/pilot/cli.js";
import { PilotError, pilotInviteLink } from "../src/pilot/invites.js";
import { BETA_READINESS_MISSING_RU, getBetaReadiness } from "../src/pilot/readiness.js";
import { decideFounderReview, founderReviewReason, pdFields } from "../src/publish/moderation.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { MemoryMailer, ORIGIN, otpLogin } from "./session.js";

const cert = testCert();

interface Fx {
  api: TestApi;
  mailer: MemoryMailer;
  alerts: OpsAlert[];
  cli(...argv: string[]): Promise<string>;
  drop(): Promise<void>;
}

async function fixture(tag: string, over: Partial<Config> = {}, migrator = false): Promise<Fx> {
  const tdb = await createTestDb(tag, { migrator });
  const mailer = new MemoryMailer();
  const alerts: OpsAlert[] = [];
  const api = await startApi(tdb.url, {
    config: { billingExemptOrgs: [DEFAULT_ORG_ID], runConcurrency: 4, ...over },
    mailer,
    alert: async (a) => {
      alerts.push(a);
    },
    creditsCronMs: 0,
    opsCheckMs: 0,
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    publish: { smoke: async () => ({ ok: true }), lockRetryDelaysMs: [10, 10, 10] },
  });
  return {
    api,
    mailer,
    alerts,
    cli: (...argv) =>
      runPilotCli(argv, {
        db: api.deps.db,
        billing: api.deps.billing,
        mailer,
        platformOrigin: api.deps.config.platformOrigin,
        llmMonthlyCapRub: api.deps.config.llmMonthlyCapRub,
      }),
    async drop() {
      await api.dispose();
      await tdb.drop();
    },
  };
}

/** A built forum with the operator of personal data set: the latest draft revision is publishable. */
async function builtSystem(api: TestApi, orgId: string): Promise<{ id: string; revision: number }> {
  const created = await api.req("POST", "/systems", { body: { prompt: "Форум ритейла", orgId } });
  expect(created.status, created.text).toBe(201);
  const id: string = created.body.system.id;
  await waitRun(api, created.body.run.id, ["succeeded"]);
  const ans = await api.req("POST", `/systems/${id}/answers`, { body: { restByRecommendation: true } });
  await waitRun(api, ans.body.run.id, ["succeeded"]);
  const s = await api.req("GET", `/systems/${id}`);
  const ap = await api.req("POST", `/systems/${id}/card/approve`, {
    body: { cardVersion: s.body.card.cardVersion },
  });
  expect(ap.status, ap.text).toBe(202);
  await waitRun(api, ap.body.run.id, ["succeeded"], 20_000);
  return { id, revision: await setOperator(api, id, "ООО «Пилот»") };
}

/** PUT compliance (a new draft revision without a build); returns it. */
async function setOperator(api: TestApi, id: string, name: string): Promise<number> {
  const put = await api.req("PUT", `/systems/${id}/compliance`, {
    body: {
      expectedVersion: (await api.req("GET", `/systems/${id}`)).body.system.draftRevision,
      operatorName: name,
      operatorContact: "privacy@pilot.example",
      operatorAddress: "г. Москва, ул. Тверская, д. 1",
    },
  });
  expect(put.status, put.text).toBe(200);
  return (await api.req("GET", `/systems/${id}`)).body.system.draftRevision as number;
}

async function publish(api: TestApi, id: string, revision: number) {
  const res = await api.req("POST", `/systems/${id}/publish`, { body: { revision, confirmDiff: true } });
  if (res.status !== 202) return { res, run: null };
  return { res, run: await waitRun(api, res.body.run.id, ["succeeded", "failed"], 30_000) };
}

describe("beta_readiness: partner invitations only after M2-13", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("m209ready", { authMode: "session", registration: "invite" });
  });
  afterAll(async () => {
    await fx?.drop();
  });

  test("without the flag `pilot invite` is refused in Russian with what is missing; nothing is sent", async () => {
    expect(await fx.cli("readiness")).toBe(
      "beta_readiness: off (не отмечалась) — приглашения партнёрам не отправляются",
    );
    const err = await fx.cli("invite", "partner@coffee.example").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PilotError);
    expect((err as Error).message).toBe(BETA_READINESS_MISSING_RU);
    expect((err as Error).message).toContain("уведомление в Роскомнадзор");
    expect((err as Error).message).toContain("pilot readiness on --by");
    expect(fx.mailer.sent).toHaveLength(0);
    const [n] = await fx.api.deps.pg`select count(*)::int as n from platform.pilot_invites`;
    expect(n?.n).toBe(0);
  });

  test("`pilot readiness on --by --note` records who/when in the DB; then invitations go out; off stops them again", async () => {
    const out = await fx.cli("readiness", "on", "--by", "founder", "--note", "РКН подано, юрист — ок");
    expect(out).toMatch(
      /^beta_readiness: on \(founder, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\) — РКН подано, юрист — ок$/,
    );
    const r = await getBetaReadiness(fx.api.deps.db);
    expect(r).toMatchObject({ on: true, by: "founder", note: "РКН подано, юрист — ок" });
    expect(Date.now() - (r.at as Date).getTime()).toBeLessThan(60_000);
    const [row] = await fx.api.deps
      .pg`select value, updated_by from platform.platform_settings where key = 'beta_readiness'`;
    expect(row).toMatchObject({ value: { on: true, note: "РКН подано, юрист — ок" }, updated_by: "founder" });

    expect(await fx.cli("invite", "partner@coffee.example")).toMatch(/приглашение отправлено/);
    const letter = fx.mailer.last("partner@coffee.example", "invite");
    // The letter links to S-auth with the address, then the pilot onboarding (S-welcome).
    expect(letter?.text).toContain(pilotInviteLink(ORIGIN, "partner@coffee.example"));
    expect(pilotInviteLink(ORIGIN, "a@b.ru")).toBe(`${ORIGIN}/login?email=a%40b.ru&next=%2Fwelcome`);
    expect(letter?.text).toContain("посмотрит модератор");

    await fx.cli("readiness", "off", "--by", "founder");
    await expect(fx.cli("invite", "other@coffee.example")).rejects.toThrow(/готовность беты/);
    await expect(fx.cli("readiness", "maybe")).rejects.toThrow(PilotError);
    await fx.cli("readiness", "on");
    expect((await getBetaReadiness(fx.api.deps.db)).by).toBeTruthy();
  });
});

describe("founder review before prod (orgs.require_founder_review under WIZARD_FOUNDER_REVIEW)", () => {
  let fx: Fx;
  let orgId: string;
  beforeAll(async () => {
    fx = await fixture("m209review", { founderReviewRequired: true }, true);
    const r = await fx.api.req("POST", "/orgs", { body: { name: "Пилотная org", regionCode: "77" } });
    expect(r.status, r.text).toBe(201);
    orgId = r.body.id;
    // Pilot limits (5 prod systems): every test publishes a system of its own.
    await fx.cli("plan", orgId, "pilot");
    await fx.cli("grant", orgId, "1000");
  }, 60_000);
  afterAll(async () => {
    await fx?.drop();
  });

  test("config: off by default, on with NODE_ENV=production or WIZARD_FOUNDER_REVIEW=on", () => {
    expect(loadConfig({}).founderReviewRequired).toBe(false);
    expect(loadConfig({ NODE_ENV: "production" }).founderReviewRequired).toBe(true);
    expect(loadConfig({ NODE_ENV: "production", WIZARD_FOUNDER_REVIEW: "off" }).founderReviewRequired).toBe(
      false,
    );
    expect(loadConfig({ WIZARD_FOUNDER_REVIEW: "on" }).founderReviewRequired).toBe(true);
  });

  test("first publication: the run waits for the review (founder alerted), prod blocked until approve", async () => {
    const sys = await builtSystem(fx.api, orgId);
    expect((await fx.api.req("GET", `/systems/${sys.id}`)).body.publishBlockers).toEqual([]);
    const first = await publish(fx.api, sys.id, sys.revision);
    expect(first.run?.status).toBe("failed");
    expect(first.run?.failure).toMatchObject({ code: "GATES_FAILED" });
    expect(first.run?.failure.message_ru).toContain("посмотрит модератор");
    const [rev] = await fx.api.deps.pg`
      select status from platform.founder_reviews where system_id = ${sys.id} and revision = ${sys.revision}`;
    expect(rev?.status).toBe("pending");
    const alert = fx.alerts.find((a) => a.event === "founder_review_requested");
    expect(alert?.text).toContain(`moderation approve ${sys.id} ${sys.revision}`);
    expect(alert?.text).toContain("первая публикация системы");
    // Prod is untouched, the blocker shows and a second attempt is refused before any run.
    const get = await fx.api.req("GET", `/systems/${sys.id}`);
    expect(get.body.system.prodRevision).toBeNull();
    expect(get.body.publishBlockers).toEqual(["FOUNDER_REVIEW_PENDING"]);
    const again = await publish(fx.api, sys.id, sys.revision);
    expect(again.res.status).toBe(403);
    expect(again.res.body.code).toBe("FOUNDER_REVIEW_PENDING");

    // The moderation CLI path approves → publish succeeds; one alert per revision.
    expect(
      await decideFounderReview(fx.api.deps.db, {
        systemId: sys.id,
        revision: sys.revision,
        decision: "approve",
        note: "ok",
      }),
    ).toBe(true);
    expect((await fx.api.req("GET", `/systems/${sys.id}`)).body.publishBlockers).toEqual([]);
    const ok = await publish(fx.api, sys.id, sys.revision);
    expect(ok.run?.status, JSON.stringify(ok.run?.failure)).toBe("succeeded");
    expect(fx.alerts.filter((a) => a.event === "founder_review_requested")).toHaveLength(1);

    // A later revision without new personal-data fields publishes without review.
    const next = await setOperator(fx.api, sys.id, "ООО «Пилот плюс»");
    const re = await publish(fx.api, sys.id, next);
    expect(re.run?.status, JSON.stringify(re.run?.failure)).toBe("succeeded");
    const [n] = await fx.api.deps.pg`
      select count(*)::int as n from platform.founder_reviews where system_id = ${sys.id}`;
    expect(n?.n).toBe(1);
  }, 120_000);

  test("rejected review: the publication fails with the rejection text", async () => {
    const sys = await builtSystem(fx.api, orgId);
    await publish(fx.api, sys.id, sys.revision);
    await decideFounderReview(fx.api.deps.db, {
      systemId: sys.id,
      revision: sys.revision,
      decision: "reject",
      note: "фишинг",
    });
    const res = await publish(fx.api, sys.id, sys.revision);
    expect(res.res.status).toBe(403);
    expect(res.res.body.message_ru).toContain("Модератор не одобрил");
  }, 120_000);

  test("`pilot review-required <orgId> off` → the first publication needs no review; on restores it", async () => {
    expect(await fx.cli("review-required", orgId, "off")).toContain("только по сигналам антифрода G2");
    const sys = await builtSystem(fx.api, orgId);
    const res = await publish(fx.api, sys.id, sys.revision);
    expect(res.run?.status, JSON.stringify(res.run?.failure)).toBe("succeeded");
    expect(await fx.cli("review-required", orgId, "on")).toContain("после одобрения модератора");
    const [o] = await fx.api.deps.pg`select require_founder_review from platform.orgs where id = ${orgId}`;
    expect(o?.require_founder_review).toBe(true);
    await expect(fx.cli("review-required", orgId, "maybe")).rejects.toThrow(PilotError);
    await expect(fx.cli("review-required", "nope", "on")).rejects.toThrow(/некорректный orgId/);
  }, 120_000);

  test("founderReviewReason: switch, org flag, first publication, new personal-data fields", async () => {
    const forum = (
      await fx.api.deps.pg`
      select spec from platform.revisions r join platform.systems s on s.id = r.system_id
      where s.org_id = ${orgId} order by r.created_at desc limit 1`
    )[0]?.spec as AppSpec;
    const pd = pdFields(forum);
    expect(pd.size).toBeGreaterThan(0);
    const [live] = await fx.api.deps.pg`
      select p.system_id from platform.publications p join platform.systems s on s.id = p.system_id
      where s.org_id = ${orgId} and p.live_at is not null limit 1`;
    const systemId = live?.system_id as string;
    const base = { systemId, orgId, spec: forum, prodSpec: forum, required: true };
    expect(await founderReviewReason(fx.api.deps.db, base)).toBeNull();
    expect(
      await founderReviewReason(fx.api.deps.db, { ...base, required: false, prodSpec: null }),
    ).toBeNull();
    // The prod schema without one of the personal-data fields → the new revision adds it.
    const [firstPd] = [...pd];
    const [ent, field] = (firstPd as string).split(".");
    const older: AppSpec = {
      ...forum,
      entities: forum.entities.map((e) =>
        e.name === ent ? { ...e, fields: e.fields.filter((f) => f.name !== field) } : e,
      ),
    };
    expect(await founderReviewReason(fx.api.deps.db, { ...base, prodSpec: older })).toBe("new_pd_fields");
    const other = (await fx.api.req("POST", "/systems", { body: { prompt: "Ещё форум", orgId } })).body.system
      .id as string;
    expect(await founderReviewReason(fx.api.deps.db, { ...base, systemId: other })).toBe("first_publication");
  }, 60_000);
});

describe("pilot leftovers: new orgs in invite mode, no top-up on pilot", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("m209orgs", { authMode: "session", registration: "invite", payments: true });
    await fx.cli("readiness", "on", "--by", "test");
  });
  afterAll(async () => {
    await fx?.drop();
  });

  test("a pilot owner's new org is pilot with 0 credits and founder review; others may not create orgs", async () => {
    await fx.cli("invite", "owner@grain.example", "--org-name", "Зерно", "--credits", "50");
    const owner = await otpLogin(fx.api, fx.mailer, "owner@grain.example");
    const r = await owner.req("POST", "/orgs", { body: { name: "Зерно — второй филиал" } });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ plan: "pilot", role: "owner" });
    expect((await owner.req("GET", `/orgs/${r.body.id}/credits`)).body.available).toBe(0);
    const [o] = await fx.api.deps
      .pg`select require_founder_review from platform.orgs where id = ${r.body.id}`;
    expect(o?.require_founder_review).toBe(true);

    // A colleague invited into the pilot org (editor, no pilot org of their own) cannot create orgs.
    const pilotOrg = (await owner.req("GET", "/me")).body.memberships.find(
      (m: { orgName: string }) => m.orgName === "Зерно",
    ).orgId as string;
    const inv = await owner.req("POST", `/orgs/${pilotOrg}/invites`, {
      body: { email: "barista@grain.example", role: "editor" },
    });
    expect(inv.status, inv.text).toBe(201);
    await fx.api.deps.pg`delete from platform.auth_otps`;
    const barista = await otpLogin(fx.api, fx.mailer, "barista@grain.example");
    const refused = await barista.req("POST", "/orgs", { body: { name: "Своя кофейня" } });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "FORBIDDEN" });
    expect(refused.body.message_ru).toContain("На пилоте новые организации создаёт команда Wizard");
  });

  test("top-up on pilot → 403 even with payments on (billing.yaml#plans.topup.available_on)", async () => {
    await fx.api.deps.pg`delete from platform.auth_otps`;
    const owner = await otpLogin(fx.api, fx.mailer, "owner@grain.example");
    const orgId = (await owner.req("GET", "/me")).body.memberships[0].orgId as string;
    const r = await owner.req("POST", `/orgs/${orgId}/billing/topups`, { body: { packs: 1 } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "FORBIDDEN" });
    expect(r.body.message_ru).toContain("Докупка кредитов на тарифе «Пилот» недоступна");
  });
});

describe("open mode keeps Free org creation", () => {
  test("POST /orgs in open mode → Free", async () => {
    const fx = await fixture("m209open", { authMode: "session" });
    try {
      const s = await otpLogin(fx.api, fx.mailer, "any@example.ru");
      const r = await s.req("POST", "/orgs", { body: { name: "Вторая" } });
      expect(r.status, r.text).toBe(201);
      expect(r.body.plan).toBe("free");
    } finally {
      await fx.drop();
    }
  });
});

describe("platform mail over SMTP (WIZARD_SMTP_*)", () => {
  test("config: from parsing, TLS mode by port, startup checks", () => {
    expect(parseMailFrom("Wizard <noreply@wizard.example>")).toEqual({
      address: "noreply@wizard.example",
      name: "Wizard",
    });
    expect(parseMailFrom('"Команда Wizard" <a@b.ru>')).toEqual({ address: "a@b.ru", name: "Команда Wizard" });
    expect(parseMailFrom("a@b.ru")).toEqual({ address: "a@b.ru", name: "" });
    expect(parseMailFrom("not an address")).toBeNull();
    const env = {
      WIZARD_SMTP_HOST: "smtp.mail.example",
      WIZARD_SMTP_FROM: "Wizard <noreply@wizard.example>",
    };
    expect(loadConfig(env).smtp).toMatchObject({ port: 465, tls: "implicit", user: null });
    expect(loadConfig({ ...env, WIZARD_SMTP_PORT: "587", WIZARD_SMTP_USER: "u" }).smtp).toMatchObject({
      tls: "starttls",
      user: "u",
    });
    expect(loadConfig({ ...env, WIZARD_SMTP_TLS: "none", WIZARD_SMTP_PORT: "1025" }).smtp?.tls).toBe("none");
    expect(loadConfig({}).smtp).toBeNull();
    expect(() => assertStartupAllowed(loadConfig({ WIZARD_SMTP_HOST: "smtp.mail.example" }))).toThrow(
      /WIZARD_SMTP_FROM/,
    );
    expect(() =>
      assertStartupAllowed(
        loadConfig({
          ...env,
          WIZARD_SMTP_TLS: "none",
          NODE_ENV: "production",
          WIZARD_SECRETS_KEY: "k".repeat(40),
        }),
      ),
    ).toThrow(/WIZARD_SMTP_TLS=none/);
    expect(() => assertStartupAllowed(loadConfig({ WIZARD_OPS_ALERT_EMAIL: "nope" }))).toThrow(
      /WIZARD_OPS_ALERT_EMAIL/,
    );
    // Without SMTP the outbox stays the mailer.
    expect(platformMailer(loadConfig({})).constructor.name).toBe("OutboxMailer");
    expect(platformMailer(loadConfig(env))).toBeInstanceOf(SmtpMailer);
  });

  test.skipIf(!cert)("STARTTLS + AUTH: OTP, invite and alert letters reach the local receiver", async () => {
    const auth = { user: "noreply@wizard.example", pass: "smtp-secret" };
    const mock = await new SmtpMock({ tls: "starttls", auth, cert: cert ?? undefined }).start();
    try {
      const mailer = new SmtpMailer(
        {
          host: "localhost",
          port: mock.port,
          tls: "starttls",
          user: auth.user,
          password: auth.pass,
          from: { address: "noreply@wizard.example", name: "Команда Wizard" },
        },
        { ca: cert?.cert ?? "" },
      );
      const letters: MailMessage[] = [
        {
          kind: "otp",
          to: "anna@coffee.example",
          subject: "Код входа в Wizard: 123456",
          text: "Ваш код: 123456",
        },
        {
          kind: "invite",
          to: "anna@coffee.example",
          subject: "Приглашение в пилот Wizard",
          text: "Войти: …",
        },
        { kind: "alert", to: "founder@wizard.example", subject: "Wizard: авария", text: "Упало 3 из 5" },
      ];
      for (const l of letters) await mailer.send(l);
      expect(mock.mails).toHaveLength(3);
      const [otp] = mock.mails;
      expect(otp).toMatchObject({
        from: "noreply@wizard.example",
        to: ["anna@coffee.example"],
        secure: true,
        authUser: "noreply@wizard.example",
      });
      const data = otp?.data ?? "";
      expect(data).toMatch(/^Subject: =\?UTF-8\?B\?/m);
      expect(data).toMatch(/^From: =\?UTF-8\?B\?.+\?= <noreply@wizard\.example>$/m);
      expect(data).toMatch(/^Message-ID: <[0-9a-f-]+@wizard\.example>$/m);
      expect(data).toContain("Auto-Submitted: auto-generated");
      expect(data).toContain("X-Wizard-Kind: otp");
      const bodies = [...data.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((m) =>
        Buffer.from((m[1] ?? "").replace(/\s/g, ""), "base64").toString("utf8"),
      );
      expect(bodies.join("\n")).toContain("Ваш код: 123456");
      expect(mock.mails[2]?.to).toEqual(["founder@wizard.example"]);
    } finally {
      await mock.stop();
    }
  });

  test.skipIf(!cert)("implicit TLS; 451 is retried once; 550 is final", async () => {
    const flaky = await new SmtpMock({
      tls: "implicit",
      cert: cert ?? undefined,
      dataFailures: { code: 451, times: 1 },
    }).start();
    const rcpt = await new SmtpMock({ tls: "implicit", cert: cert ?? undefined, rcptCode: 550 }).start();
    const smtp = (port: number) =>
      new SmtpMailer(
        {
          host: "localhost",
          port,
          tls: "implicit",
          user: null,
          password: null,
          from: { address: "a@wizard.example", name: "" },
        },
        { ca: cert?.cert ?? "", retryDelayMs: 0 },
      );
    try {
      await smtp(flaky.port).send({ kind: "notice", to: "x@example.ru", subject: "Тема", text: "Текст" });
      expect(flaky.mails).toHaveLength(1);
      expect(flaky.mails[0]?.secure).toBe(true);
      await expect(
        smtp(rcpt.port).send({ kind: "notice", to: "x@example.ru", subject: "Тема", text: "Текст" }),
      ).rejects.toMatchObject({ code: 550 });
      expect(rcpt.connections).toBe(1);
    } finally {
      await flaky.stop();
      await rcpt.stop();
    }
  });

  test("platform-api with WIZARD_SMTP_* sends the OTP over SMTP (plaintext local receiver outside production)", async () => {
    const mock = await new SmtpMock({ tls: "none" }).start();
    const tdb = await createTestDb("m209smtp");
    const api = await startApi(tdb.url, {
      config: {
        authMode: "session",
        smtp: {
          host: "127.0.0.1",
          port: mock.port,
          tls: "none",
          user: null,
          password: null,
          from: { address: "noreply@wizard.example", name: "Wizard" },
        },
      },
      creditsCronMs: 0,
      opsCheckMs: 0,
    });
    try {
      const r = await api.req("POST", "/auth/otp/request", {
        body: { email: "mail@coffee.example" },
        headers: { origin: ORIGIN },
      });
      expect(r.status).toBe(204);
      expect(mock.mails).toHaveLength(1);
      expect(mock.mails[0]?.to).toEqual(["mail@coffee.example"]);
      expect(mock.mails[0]?.data).toContain("X-Wizard-Kind: otp");
    } finally {
      await api.dispose();
      await tdb.drop();
      await mock.stop();
    }
  });

  test("production without SMTP and without an injected mailer refuses to start", async () => {
    const tdb = await createTestDb("m209prod");
    try {
      await expect(
        startApi(tdb.url, {
          config: {
            nodeEnv: "production",
            authMode: "session",
            secretsKey: "k".repeat(40),
            billingExemptOrgs: [],
          },
          creditsCronMs: 0,
        }),
      ).rejects.toThrow(/WIZARD_SMTP_HOST/);
    } finally {
      await tdb.drop();
    }
  });

  test("founder alerts also go by e-mail (WIZARD_OPS_ALERT_EMAIL); a mail failure never throws", async () => {
    const mailer = new MemoryMailer();
    const errors: string[] = [];
    const alert = createOpsAlert({
      mail: { mailer, to: "founder@wizard.example" },
      onError: (m) => errors.push(m),
    });
    await alert({ level: "error", event: "run_failure_rate_high", text: "Wizard: упало 3 из 5" });
    expect(mailer.last("founder@wizard.example", "alert")).toMatchObject({
      subject: "Wizard: авария (run_failure_rate_high)",
      text: "Wizard: упало 3 из 5",
    });
    const broken = createOpsAlert({
      mail: {
        mailer: {
          send: async () => {
            throw new Error("smtp down");
          },
        },
        to: "founder@wizard.example",
      },
      onError: (m) => errors.push(m),
    });
    await broken({ level: "warn", event: "x", text: "y" });
    expect(errors).toEqual(["ops alert mail failed"]);
  });
});

describe("run metrics and the run failure-rate founder alert", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("m209metrics");
  });
  afterAll(async () => {
    await fx?.drop();
  });

  test("/metrics: runs started/finished by kind, durations, gate failures, DB gauges; dedicated listener", async () => {
    const created = await fx.api.req("POST", "/systems", { body: { prompt: "Форум ритейла" } });
    await waitRun(fx.api, created.body.run.id, ["succeeded"]);
    const s = await startMetricsServer({ port: 0, hostname: "127.0.0.1", db: fx.api.deps.db, capRub: 6000 });
    try {
      const text = await (await fetch(`http://127.0.0.1:${s.port}/metrics`)).text();
      expect(text).toMatch(/wizard_runs_started_total\{kind="interview_turn"\} [1-9]/);
      expect(text).toMatch(/wizard_runs_finished_total\{kind="interview_turn",status="succeeded"\} [1-9]/);
      expect(text).toMatch(
        /wizard_run_duration_seconds_count\{kind="interview_turn",status="succeeded"\} [1-9]/,
      );
      expect(text).toContain('wizard_runs_active{kind="build",status="queued"} 0');
      expect(text).toMatch(/wizard_llm_cost_rub\{month="\d{4}-\d{2}"\} 0/);
      expect(text).toContain("wizard_llm_monthly_cap_rub 6000");
      expect(text).toContain("wizard_founder_reviews_pending 0");
      expect(text).toContain("wizard_runs_failed_ratio_1h 0");
      expect(text).not.toContain("Форум");
      expect((await fetch(`http://127.0.0.1:${s.port}/api/v1/me`)).status).toBe(404);
    } finally {
      await s.close();
    }
    // Gate failures are counted by check id.
    const { recordGate } = await import("../src/ops/metrics.js");
    recordGate({ level: "G2", passed: false, checks: [{ id: "G2-AF-01", status: "fail" }] });
    expect(await platformMetrics.render()).toContain(
      'wizard_gate_check_failures_total{level="G2",check="G2-AF-01"} 1',
    );
  }, 30_000);

  test("> 20 % failed of ≥ 5 finished in the last hour → one founder alert per clock hour", async () => {
    const pg = fx.api.deps.pg;
    // A window of its own, away from the runs of the other tests.
    const now = new Date(Date.now() + 10 * 24 * 3600_000);
    const ins = (status: string, n: number) =>
      pg`insert into platform.runs (org_id, kind, status, started_at, finished_at)
         select ${DEFAULT_ORG_ID}, 'build', ${status}, ${now}, ${now} from generate_series(1, ${n})`;
    const alerts: OpsAlert[] = [];
    const alert = async (a: OpsAlert) => void alerts.push(a);
    await ins("failed", 2);
    // Two failures of two: below the minimum sample — no alert.
    expect(await checkRunFailureRate(fx.api.deps.db, alert, now)).toMatchObject({
      failed: 2,
      alerted: false,
    });
    await ins("succeeded", 8);
    // 2 of 10 = 20 %: not above the threshold.
    expect((await checkRunFailureRate(fx.api.deps.db, alert, now)).alerted).toBe(false);
    await ins("failed", 1);
    const r = await checkRunFailureRate(fx.api.deps.db, alert, now);
    expect(r).toMatchObject({ failed: 3, finished: 11, alerted: true });
    expect(alerts[0]).toMatchObject({ level: "error", event: "run_failure_rate_high" });
    expect(alerts[0]?.text).toContain("упало 3 из 11 прогонов (27 %, порог 20 %)");
    // Once per clock hour.
    expect((await checkRunFailureRate(fx.api.deps.db, alert, now)).alerted).toBe(false);
    expect(alerts).toHaveLength(1);
    // Runs older than an hour do not count.
    const later = new Date(now.getTime() + 2 * 3600_000);
    expect(await checkRunFailureRate(fx.api.deps.db, alert, later)).toMatchObject({
      finished: 0,
      alerted: false,
    });
  });
});
