// «Написать команде» (D68, M2-35 mvp_scope): the message reaches the founder through the alert channel (Telegram bot of
// the platform) with the org, the client's address and a link to the system, PII of the text masked; a copy is listed
// in /admin with the «отвечено» mark; the client gets a confirmation with a concrete reply time (D60); rate limits.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import type { OpsAlert } from "../src/ops/alert.js";
import { deadlineRu, replyDeadline, SUPPORT_PER_USER_HOUR } from "../src/support/service.js";
import { toCard } from "./flow.js";
import { createTestDb, fakeExecutors, fakeRouterFactory, startApi, type TestApi } from "./helpers.js";
import { devLogin, expectContract, type Session } from "./session.js";

/** Moscow wall time → instant (UTC+3). */
const msk = (s: string) => new Date(`${s}+03:00`);

describe("reply deadline: 2 working hours, Mon–Fri 10–19 MSK (D60)", () => {
  test.each([
    ["2026-10-07T12:00:00", "2026-10-07T14:00:00"], // Wednesday, inside
    ["2026-10-09T18:30:00", "2026-10-12T11:30:00"], // Friday evening → Monday
    ["2026-10-08T18:00:00", "2026-10-09T11:00:00"], // Thursday → Friday morning
    ["2026-10-10T15:00:00", "2026-10-12T12:00:00"], // Saturday → Monday 12:00
    ["2026-10-06T08:00:00", "2026-10-06T12:00:00"], // before the day starts
    ["2026-10-06T21:00:00", "2026-10-07T12:00:00"], // after hours
  ])("%s → %s", (from, to) => {
    expect(replyDeadline(msk(from)).toISOString()).toBe(msk(to).toISOString());
  });

  test("words: today, tomorrow, a weekday", () => {
    expect(deadlineRu(msk("2026-10-07T14:00:00"), msk("2026-10-07T12:00:00"))).toBe("сегодня до 14:00");
    expect(deadlineRu(msk("2026-10-09T11:00:00"), msk("2026-10-08T18:00:00"))).toBe("завтра до 11:00");
    expect(deadlineRu(msk("2026-10-12T11:30:00"), msk("2026-10-09T18:30:00"))).toBe("в понедельник до 11:30");
  });
});

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let client: Session;
let staff: Session;
let orgId = "";
let systemId = "";
const alerts: OpsAlert[] = [];
let clock = msk("2026-10-09T18:30:00");

beforeAll(async () => {
  tdb = await createTestDb("support");
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    abuseSlaMs: 0,
    alert: async (a) => {
      alerts.push(a);
    },
    now: () => clock,
  });
  client = await devLogin(api, "anna@bakery.example");
  orgId = (await client.req("GET", "/me")).body.memberships[0].orgId;
  await api.deps.db
    .updateTable("platform.orgs")
    .set({ name: "Пекарня «Колос»" })
    .where("id", "=", orgId)
    .execute();
  systemId = (await toCard({ ...api, req: client.req } as TestApi)).systemId;
  staff = await devLogin(api, "founder-support@example.test");
  await setStaff(api.deps.db, "founder-support@example.test", true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const supportAlerts = () => alerts.filter((a) => a.event === "support_request");

describe("POST /support/requests", () => {
  test("from a system: Telegram text with org, address, link, deadline and masked phone; confirmation with the term", async () => {
    const r = await client.req("POST", "/support/requests", {
      body: {
        text: "Не получается добавить оплату. Позвоните мне: +7 916 123-45-67",
        wantsTeam: true,
        systemId,
        screen: "system",
      },
    });
    expect(r.status, r.text).toBe(201);
    expectContract("createSupportRequest", r);
    expect(r.body.replyBy).toBe(msk("2026-10-12T11:30:00").toISOString());
    expect(r.body.message_ru).toBe(
      "Сообщение отправлено. Ответим письмом на anna@bakery.example в понедельник до 11:30 по московскому времени. Команда работает по будням с 10 до 19.",
    );
    const [a] = supportAlerts();
    expect(a?.text).toContain("хочет, чтобы доделала команда");
    expect(a?.text).toContain("Организация: Пекарня «Колос»");
    expect(a?.text).toContain("Клиент: anna@bakery.example");
    expect(a?.text).toContain(`${api.deps.config.platformOrigin}/s/${systemId}`);
    expect(a?.text).toContain("Ответить письмом до 12.10 11:30 МСК");
    expect(a?.text).toContain("Не получается добавить оплату");
    expect(a?.text).not.toContain("123-45-67");
    // The structured log line carries no text of the client.
    expect(JSON.stringify(a?.fields)).not.toMatch(/оплат|anna/);
    const [row] = await api.deps.db.selectFrom("platform.support_requests").selectAll().execute();
    expect(row).toMatchObject({ org_id: orgId, system_id: systemId, wants_team: true, screen: "system" });
    expect(row?.text).toContain("+7 916 123-45-67");
  });

  test("without a system: «Система: не открыта»; another org's system → 404; empty text → 400", async () => {
    const r = await client.req("POST", "/support/requests", { body: { text: "Вопрос по лимитам" } });
    expect(r.status).toBe(201);
    expect(supportAlerts().at(-1)?.text).toContain("Система: не открыта");
    const stranger = await devLogin(api, "stranger-support@example.test");
    const foreign = await stranger.req("POST", "/support/requests", { body: { text: "Привет", systemId } });
    expect(foreign.status).toBe(404);
    expectContract("createSupportRequest", foreign);
    expect((await client.req("POST", "/support/requests", { body: { text: "  " } })).status).toBe(400);
  });

  test(`more than ${SUPPORT_PER_USER_HOUR} messages an hour → 429; an hour later it works again`, async () => {
    for (let i = 2; i < SUPPORT_PER_USER_HOUR; i++)
      expect((await client.req("POST", "/support/requests", { body: { text: `Ещё ${i}` } })).status).toBe(
        201,
      );
    const limited = await client.req("POST", "/support/requests", { body: { text: "Слишком часто" } });
    expect(limited.status).toBe(429);
    expectContract("createSupportRequest", limited);
    clock = new Date(clock.getTime() + 61 * 60_000);
    expect((await client.req("POST", "/support/requests", { body: { text: "Через час" } })).status).toBe(201);
  });
});

describe("/admin «Обращения»", () => {
  test("staff lists open requests with the client's address and system; marks answered (journal); non-staff 404", async () => {
    expect((await client.req("GET", "/admin/support/requests")).status).toBe(404);
    const list = await staff.req("GET", "/admin/support/requests?status=open");
    expect(list.status, list.text).toBe(200);
    expectContract("adminListSupportRequests", list);
    const first = list.body.items.find((x: { systemId: string | null }) => x.systemId === systemId);
    expect(first).toMatchObject({
      orgName: "Пекарня «Колос»",
      email: "anna@bakery.example",
      systemName: expect.any(String),
      wantsTeam: true,
      answeredAt: null,
    });
    const mark = await staff.req("POST", `/admin/support/requests/${first.id}/answered`, {
      body: { answered: true },
    });
    expect(mark.status).toBe(200);
    expectContract("adminMarkSupportRequest", mark);
    expect(mark.body.answeredAt).not.toBeNull();
    const open = await staff.req("GET", "/admin/support/requests?status=open");
    expect(open.body.items.some((x: { id: string }) => x.id === first.id)).toBe(false);
    const all = await staff.req("GET", "/admin/support/requests");
    expect(all.body.items.at(-1).id).toBe(first.id);
    const audit = await api.deps.db
      .selectFrom("platform.staff_audit_log")
      .selectAll()
      .where("action", "=", "support_answered")
      .execute();
    expect(audit.map((x) => x.target)).toEqual([`support_request:${first.id}`]);
    expect(
      (
        await client.req("POST", `/admin/support/requests/${first.id}/answered`, {
          body: { answered: false },
        })
      ).status,
    ).toBe(404);
  });
});
