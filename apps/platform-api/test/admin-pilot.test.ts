// Staff console «Пилот» (/admin/pilot/*, docs/reviews/impl-notes/pilot-admin.md): only staff with TOTP in the session
// (non-staff 404, no step-up 403 MFA_REQUIRED); beta_readiness with who/when, confirmation and a note; founder
// invitations through the same createPilotInvite as the CLI (refused with BETA_READINESS_MISSING_RU while the flag is
// off), statuses sent / accepted / expired, revoke; pilot orgs with the month's spend, grants by reference, the
// founder-review flag; the platform LLM spend vs the cap with the 80 % warning. Every change → staff_audit_log.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import { runPilotCli } from "../src/pilot/cli.js";
import { BETA_READINESS_CHECKLIST_RU, BETA_READINESS_MISSING_RU } from "../src/pilot/readiness.js";
import { createTestDb, startApi, type TestApi } from "./helpers.js";
import { devLogin, expectContract, MemoryMailer, otpLogin, type Session } from "./session.js";

const STAFF = "founder-pilot@example.test";
const USER = "plain-pilot-user@example.test";
const CLIENT = "owner@coffee.example";
const CAP = 1000;
const NO_ID = "00000000-0000-4000-8000-000000000000";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const mailer = new MemoryMailer();
let staff: Session;
let user: Session;
let clientOrg = "";
let clientInvite = "";

beforeAll(async () => {
  tdb = await createTestDb("adminpilot");
  api = await startApi(tdb.url, { mailer, abuseSlaMs: 0, config: { llmMonthlyCapRub: CAP } });
  staff = await devLogin(api, STAFF);
  await setStaff(api.deps.db, STAFF, true);
  user = await devLogin(api, USER);
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const audit = (action: string) =>
  api.deps.db
    .selectFrom("platform.staff_audit_log")
    .selectAll()
    .where("action", "=", action)
    .orderBy("id")
    .execute();

const cli = (...argv: string[]) =>
  runPilotCli(argv, {
    db: api.deps.db,
    billing: api.deps.billing,
    mailer,
    platformOrigin: api.deps.config.platformOrigin,
    llmMonthlyCapRub: CAP,
  });

const ENDPOINTS: [string, string, unknown?][] = [
  ["GET", "/admin/pilot/readiness"],
  ["PUT", "/admin/pilot/readiness", { on: true, confirm: true, note: "всё готово" }],
  ["GET", "/admin/pilot/invites"],
  ["POST", "/admin/pilot/invites", { email: "x@example.test" }],
  ["POST", `/admin/pilot/invites/${NO_ID}/revoke`],
  ["GET", "/admin/pilot/orgs"],
  ["POST", `/admin/pilot/orgs/${NO_ID}/grants`, { credits: 10, reference: "ref-1" }],
  ["PUT", `/admin/pilot/orgs/${NO_ID}/founder-review`, { on: false }],
  ["GET", "/admin/pilot/spend"],
];

describe("/admin/pilot: staff only, with TOTP in the session", () => {
  test("non-staff → 404 on every endpoint (nothing changes); dev header → 404; staff without MFA → 403 MFA_REQUIRED", async () => {
    for (const [m, p, body] of ENDPOINTS) {
      const r = await user.req(m, p, body === undefined ? {} : { body });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.code).toBe("NOT_FOUND");
      expect((await api.req(m, p, body === undefined ? {} : { body })).status, `dev ${m} ${p}`).toBe(404);
    }
    for (const [m, p, body] of ENDPOINTS) {
      const r = await staff.req(m, p, body === undefined ? {} : { body });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.code).toBe("MFA_REQUIRED");
    }
    const settings = await api.deps.db.selectFrom("platform.platform_settings").selectAll().execute();
    expect(settings).toEqual([]);
    expect(await api.deps.db.selectFrom("platform.pilot_invites").selectAll().execute()).toEqual([]);
  });

  test("after TOTP enrolment the section answers", async () => {
    const en = await staff.req("POST", "/admin/mfa/enroll");
    expect(en.status, en.text).toBe(200);
    const ok = await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
    expect(ok.status, ok.text).toBe(200);
    const r = await staff.req("GET", "/admin/pilot/readiness");
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("beta_readiness switch and the invitation gate", () => {
  test("off: the checklist is shown; an invitation is refused with the CLI's Russian text, no letter, no journal row", async () => {
    const r = await staff.req("GET", "/admin/pilot/readiness");
    expectContract("adminPilotReadiness", r);
    expect(r.body).toEqual({
      on: false,
      by: null,
      at: null,
      note: null,
      checklist: BETA_READINESS_CHECKLIST_RU,
    });
    expect(r.body.checklist.map((x: { id: string }) => x.id)).toEqual([
      "rkn",
      "lawyer",
      "dpa",
      "zai",
      "security",
      "pilot_d25",
    ]);
    const sent = mailer.sent.length;
    const inv = await staff.req("POST", "/admin/pilot/invites", {
      body: { email: CLIENT, orgName: "Кофейня «Зерно»", credits: 150 },
    });
    expect(inv.status).toBe(403);
    expectContract("adminCreatePilotInvite", inv);
    expect(inv.body).toEqual({ code: "FORBIDDEN", message_ru: BETA_READINESS_MISSING_RU });
    expect(mailer.sent.length).toBe(sent);
    expect(await audit("pilot_invite")).toEqual([]);
  });

  test("on needs confirm and a note (400); then who = staff e-mail, when, note; journal row; the CLI sees the same flag", async () => {
    for (const body of [
      { on: true, note: "РКН подано" },
      { on: true, confirm: true },
      { on: true, confirm: true, note: " a " },
    ]) {
      const bad = await staff.req("PUT", "/admin/pilot/readiness", { body });
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.body.code).toBe("VALIDATION_FAILED");
    }
    expect(await audit("pilot_readiness_on")).toEqual([]);
    const r = await staff.req("PUT", "/admin/pilot/readiness", {
      body: { on: true, confirm: true, note: "РКН подано, юрист — ок" },
    });
    expect(r.status, r.text).toBe(200);
    expectContract("adminSetPilotReadiness", r);
    expect(r.body).toMatchObject({ on: true, by: STAFF, note: "РКН подано, юрист — ок" });
    expect(Date.now() - Date.parse(r.body.at)).toBeLessThan(60_000);
    const [row] = await audit("pilot_readiness_on");
    expect(row).toMatchObject({
      actor: staff.userId,
      target: "platform_settings:beta_readiness",
      note: "РКН подано, юрист — ок",
    });
    expect(await cli("readiness")).toMatch(
      /^beta_readiness: on \(founder-pilot@example\.test, .* — РКН подано, юрист — ок$/,
    );
    // Off needs no confirmation; the gate closes again.
    const off = await staff.req("PUT", "/admin/pilot/readiness", { body: { on: false } });
    expect(off.body).toMatchObject({ on: false, by: STAFF, note: null });
    expect((await audit("pilot_readiness_off")).length).toBe(1);
    expect((await staff.req("POST", "/admin/pilot/invites", { body: { email: CLIENT } })).status).toBe(403);
    expect(
      (
        await staff.req("PUT", "/admin/pilot/readiness", {
          body: { on: true, confirm: true, note: "снова готово" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("invitations", () => {
  test("invite → 201 with the link, the letter goes out, journal row without the e-mail; the list shows «sent»", async () => {
    const r = await staff.req("POST", "/admin/pilot/invites", {
      body: {
        email: "Owner@Coffee.example",
        orgName: "Кофейня «Зерно»",
        credits: 150,
        requireFounderReview: false,
      },
    });
    expect(r.status, r.text).toBe(201);
    expectContract("adminCreatePilotInvite", r);
    clientInvite = r.body.id;
    expect(r.body).toMatchObject({ email: CLIENT, requireFounderReview: false });
    expect(r.body.link).toBe(
      `${api.deps.config.platformOrigin}/login?email=${encodeURIComponent(CLIENT)}&next=%2Fwelcome`,
    );
    const letter = mailer.last(CLIENT, "invite");
    expect(letter?.text).toContain(r.body.link);
    expect(letter?.text).not.toContain("посмотрит модератор");
    const [row] = await audit("pilot_invite");
    expect(row).toMatchObject({ actor: staff.userId, target: `pilot_invite:${clientInvite}` });
    expect(row?.note).toBe("кредиты 150, ревью выкл");
    expect(JSON.stringify(await audit("pilot_invite"))).not.toContain("coffee");
    const list = await staff.req("GET", "/admin/pilot/invites");
    expectContract("adminListPilotInvites", list);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: clientInvite,
        email: CLIENT,
        orgName: "Кофейня «Зерно»",
        credits: 150,
        requireFounderReview: false,
        status: "sent",
        acceptedAt: null,
        orgId: null,
      }),
    ]);
  });

  test("bad input → 400 with the shared Russian messages; an already registered address is refused", async () => {
    const bad = await staff.req("POST", "/admin/pilot/invites", { body: { email: "not-an-email" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message_ru).toContain("некорректный email");
    const reg = await staff.req("POST", "/admin/pilot/invites", { body: { email: USER } });
    expect(reg.status).toBe(400);
    expect(reg.body.message_ru).toContain("уже зарегистрирован");
    expect(
      (await staff.req("POST", "/admin/pilot/invites", { body: { email: CLIENT, credits: -1 } })).status,
    ).toBe(400);
  });

  test("the client signs in → «accepted», the pilot org takes the invitation's name, credits and review flag", async () => {
    const client = await otpLogin(api, mailer, CLIENT);
    const me = await client.req("GET", "/me");
    clientOrg = me.body.memberships[0].orgId;
    const org = await api.deps.db
      .selectFrom("platform.orgs")
      .select(["name", "plan", "require_founder_review"])
      .where("id", "=", clientOrg)
      .executeTakeFirstOrThrow();
    expect(org).toEqual({ name: "Кофейня «Зерно»", plan: "pilot", require_founder_review: false });
    const list = await staff.req("GET", "/admin/pilot/invites");
    expect(list.body.items[0]).toMatchObject({ id: clientInvite, status: "accepted", orgId: clientOrg });
    // An accepted invitation cannot be revoked.
    expect((await staff.req("POST", `/admin/pilot/invites/${clientInvite}/revoke`)).status).toBe(404);
  });

  test("default review flag is on; expired invitations show «expired»; revoke → journal, gone from the list, second revoke 404", async () => {
    const a = await staff.req("POST", "/admin/pilot/invites", { body: { email: "late@example.ru" } });
    expect(a.body.requireFounderReview).toBe(true);
    const b = await staff.req("POST", "/admin/pilot/invites", {
      body: { email: "gone@example.ru", credits: 5 },
    });
    const stored = await api.deps.db
      .selectFrom("platform.pilot_invites")
      .select("require_founder_review")
      .where("id", "=", a.body.id)
      .executeTakeFirstOrThrow();
    expect(stored.require_founder_review).toBe(true);
    await api.deps
      .pg`update platform.pilot_invites set expires_at = now() - interval '1 minute' where id = ${a.body.id}`;
    const list = await staff.req("GET", "/admin/pilot/invites");
    const status = Object.fromEntries(
      list.body.items.map((x: { id: string; status: string }) => [x.id, x.status]),
    );
    expect(status).toEqual({ [a.body.id]: "expired", [b.body.id]: "sent", [clientInvite]: "accepted" });
    const rv = await staff.req("POST", `/admin/pilot/invites/${b.body.id}/revoke`);
    expect(rv.status, rv.text).toBe(200);
    expectContract("adminRevokePilotInvite", rv);
    expect(rv.body).toEqual({ id: b.body.id, status: "revoked" });
    expect((await audit("pilot_invite_revoke")).map((x) => x.target)).toEqual([`pilot_invite:${b.body.id}`]);
    const after = await staff.req("GET", "/admin/pilot/invites");
    expect(after.body.items.map((x: { id: string }) => x.id)).not.toContain(b.body.id);
    expect((await staff.req("POST", `/admin/pilot/invites/${b.body.id}/revoke`)).status).toBe(404);
    expect((await staff.req("POST", "/admin/pilot/invites/nope/revoke")).status).toBe(404);
    // The CLI lists the same rows.
    expect(await cli("invites")).toMatch(/late@example\.ru\t—\t0 кр\.\tистекло/);
  });
});

describe("CLI keeps working on the shared functions", () => {
  test("`pilot invite --review off` stores the flag; a wrong value is refused", async () => {
    expect(await cli("invite", "cli-client@example.ru", "--review", "off")).toContain(
      "приглашение отправлено",
    );
    const row = await api.deps.db
      .selectFrom("platform.pilot_invites")
      .select("require_founder_review")
      .where("email", "=", "cli-client@example.ru")
      .executeTakeFirstOrThrow();
    expect(row.require_founder_review).toBe(false);
    await expect(cli("invite", "cli-client@example.ru", "--review", "maybe")).rejects.toThrow(
      "--review: on или off",
    );
    expect(await cli("revoke", "cli-client@example.ru")).toBe("приглашение отозвано");
  });
});

describe("pilot orgs, grants, review flag and the platform spend", () => {
  async function spend(rub: number, orgId: string = clientOrg): Promise<void> {
    await api.deps.pg`
      insert into platform.llm_calls (org_id, call_type, tier, provider, model_id, status, route_reason,
        policy_version, scrubbed, cost_rub, billable, mode)
      values (${orgId}, 'orchestrate', 'T0', 'cloudru', 'glm-5.1', 'ok', 'default_T0', 'test', false, ${rub},
        true, 'live')`;
  }

  test("orgs: only pilot orgs, with members, available and spent credits, model ₽ of the month and the cap", async () => {
    await spend(120.5);
    const r = await staff.req("GET", "/admin/pilot/orgs");
    expect(r.status, r.text).toBe(200);
    expectContract("adminListPilotOrgs", r);
    expect(r.body.capRub).toBe(CAP);
    expect(r.body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.body.items).toEqual([
      {
        id: clientOrg,
        name: "Кофейня «Зерно»",
        plan: "pilot",
        members: 1,
        requireFounderReview: false,
        creditsAvailable: 150,
        creditsSpentMonth: 0,
        modelSpendRub: 120.5,
      },
    ]);
  });

  test("grant: reference required; the same reference grants once; both journaled; unknown org 404", async () => {
    for (const body of [
      { credits: 50 },
      { credits: 0, reference: "договор-1" },
      { credits: 50, reference: "ab" },
      { credits: 200_000, reference: "договор-1" },
    ]) {
      const bad = await staff.req("POST", `/admin/pilot/orgs/${clientOrg}/grants`, { body });
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }
    const g = await staff.req("POST", `/admin/pilot/orgs/${clientOrg}/grants`, {
      body: { credits: 50, reference: "договор-1" },
    });
    expect(g.status, g.text).toBe(200);
    expectContract("adminGrantPilotCredits", g);
    expect(g.body).toEqual({
      orgId: clientOrg,
      granted: true,
      reference: "договор-1",
      creditsAvailable: 200,
    });
    const again = await staff.req("POST", `/admin/pilot/orgs/${clientOrg}/grants`, {
      body: { credits: 50, reference: "договор-1" },
    });
    expect(again.body).toMatchObject({ granted: false, creditsAvailable: 200 });
    const rows = await audit("pilot_grant");
    expect(rows.map((x) => [x.target, x.note])).toEqual([
      [`org:${clientOrg}`, "50 кр., reference договор-1"],
      [`org:${clientOrg}`, "50 кр., reference договор-1 (уже начислено ранее)"],
    ]);
    const ledger = await api.deps.db
      .selectFrom("platform.credit_ledger")
      .select(["created_by"])
      .where("org_id", "=", clientOrg)
      .where("idempotency_key", "=", "pilot_grant:договор-1")
      .execute();
    expect(ledger).toEqual([{ created_by: staff.userId }]);
    expect(
      (
        await staff.req("POST", `/admin/pilot/orgs/${NO_ID}/grants`, {
          body: { credits: 5, reference: "ref-1" },
        })
      ).status,
    ).toBe(404);
  });

  test("founder-review toggle: orgs.require_founder_review and a journal row", async () => {
    const r = await staff.req("PUT", `/admin/pilot/orgs/${clientOrg}/founder-review`, { body: { on: true } });
    expect(r.status, r.text).toBe(200);
    expectContract("adminSetPilotFounderReview", r);
    expect(r.body).toEqual({ orgId: clientOrg, requireFounderReview: true });
    const org = await api.deps.db
      .selectFrom("platform.orgs")
      .select("require_founder_review")
      .where("id", "=", clientOrg)
      .executeTakeFirstOrThrow();
    expect(org.require_founder_review).toBe(true);
    expect((await audit("pilot_review_required")).map((x) => [x.target, x.note])).toEqual([
      [`org:${clientOrg}`, "вкл"],
    ]);
    expect(
      (await staff.req("PUT", `/admin/pilot/orgs/${NO_ID}/founder-review`, { body: { on: true } })).status,
    ).toBe(404);
  });

  test("spend: the month vs the cap, warn from 80 %, reached at 100 %; same numbers as `pilot spend`", async () => {
    const low = await staff.req("GET", "/admin/pilot/spend");
    expectContract("adminPilotSpend", low);
    expect(low.body).toMatchObject({
      spentRub: 120.5,
      capRub: CAP,
      sharePercent: 12,
      warn: false,
      reached: false,
    });
    // Spend of a non-pilot org (the staff's own) counts for the platform cap too.
    const staffOrg = (await staff.req("GET", "/me")).body.memberships[0].orgId as string;
    await spend(680, staffOrg);
    const warn = await staff.req("GET", "/admin/pilot/spend");
    expect(warn.body).toMatchObject({ spentRub: 800.5, sharePercent: 80, warn: true, reached: false });
    expect(await cli("spend")).toMatch(
      new RegExp(`^модели за ${warn.body.month} \\(МСК\\): 800,5 ₽ из 1\\s000 ₽ \\(80 %\\)$`),
    );
    await spend(200);
    expect((await staff.req("GET", "/admin/pilot/spend")).body).toMatchObject({ warn: true, reached: true });
  });
});
