// Acceptance M1-02: organizations, members (LAST_OWNER), invites (TTL, e-mail match, PLAN_LIMIT), settings and the
// org region → t1_restricted (data-boundary.yaml#region_restriction, L3-02).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { applyRegion, innValid, isRestrictedRegion } from "../src/auth/region.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitFor,
} from "./helpers.js";
import { devLogin, expectContract, MemoryMailer, ORIGIN, otpLogin, type Session } from "./session.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const mailer = new MemoryMailer();
const geo = new Map<string, string>();

beforeAll(async () => {
  tdb = await createTestDb("orgs");
  api = await startApi(tdb.url, {
    config: { authMode: "session", devLogin: true },
    mailer,
    geoRegion: (ip) => geo.get(ip) ?? null,
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
  });
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

/** A valid INN-10 starting with `prefix` (check digit brute-forced with innValid, which is tested on real INNs). */
function inn10(prefix: string): string {
  for (let d = 0; d < 10; d++) {
    const v = `${prefix}1234567${d}`.slice(0, 10);
    if (innValid(v)) return v;
  }
  throw new Error("no inn");
}

const waitRun = (s: Session, runId: string) =>
  waitFor(async () => (await s.req("GET", `/runs/${runId}`)).body.status === "succeeded");

async function newOrg(s: Session, body: Record<string, unknown> = { name: "Студия" }) {
  const r = await s.req("POST", "/orgs", { body });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe("organizations", () => {
  test("create → owner; list/get; rename by owner only", async () => {
    const owner = await devLogin(api, "org-owner@example.ru");
    const r = await owner.req("POST", "/orgs", { body: { name: "  Кофейня  " } });
    expect(r.status).toBe(201);
    expectContract("createOrg", r);
    expect(r.body).toMatchObject({ name: "Кофейня", plan: "free", role: "owner", cardBound: false });
    const list = await owner.req("GET", "/orgs");
    expectContract("listOrgs", list);
    expect(list.body.items.map((o: { id: string }) => o.id)).toContain(r.body.id);
    const got = await owner.req("GET", `/orgs/${r.body.id}`);
    expectContract("getOrg", got);
    const patched = await owner.req("PATCH", `/orgs/${r.body.id}`, { body: { name: "Кофейня на углу" } });
    expectContract("updateOrg", patched);
    expect(patched.body.name).toBe("Кофейня на углу");
    expect((await owner.req("POST", "/orgs", { body: { name: "" } })).status).toBe(400);
  });

  test("settings: viewer reads, owner toggles ruOnly (editor → 403)", async () => {
    const owner = await devLogin(api, "set-owner@example.ru");
    const orgId = await newOrg(owner, { name: "Настройки", regionCode: "77" });
    const editor = await devLogin(api, "set-editor@example.ru");
    await api.deps
      .pg`insert into platform.memberships (org_id, user_id, role) values (${orgId}, ${editor.userId}, 'editor')`;
    const g = await editor.req("GET", `/orgs/${orgId}/settings`);
    expectContract("getOrgSettings", g);
    expect(g.body.ruOnly).toBe(false);
    expect((await editor.req("PATCH", `/orgs/${orgId}/settings`, { body: { ruOnly: true } })).status).toBe(
      403,
    );
    const p = await owner.req("PATCH", `/orgs/${orgId}/settings`, { body: { ruOnly: true } });
    expectContract("updateOrgSettings", p);
    expect(p.body).toMatchObject({ ruOnly: true, buildModelLabel: "модели в РФ" });
    expect((await owner.req("PATCH", `/orgs/${orgId}/settings`, { body: { ruOnly: "yes" } })).status).toBe(
      400,
    );
  });
});

describe("region → t1_restricted", () => {
  test("INN checksum on real numbers; restricted list 90–95", () => {
    expect(innValid("7707083893")).toBe(true);
    expect(innValid("7707083894")).toBe(false);
    expect(innValid("500100732259")).toBe(true);
    expect(innValid("500100732258")).toBe(false);
    expect(["90", "91", "92", "93", "94", "95"].every(isRestrictedRegion)).toBe(true);
    expect(isRestrictedRegion("77") || isRestrictedRegion("89") || isRestrictedRegion("96")).toBe(false);
    expect(applyRegion({ region_code: "91", t1_restricted: true }, { regionCode: "77" })).toEqual({
      region_code: "77",
      t1_restricted: true,
    });
  });

  const flags = async (orgId: string) =>
    (await api.deps.pg`select region_code, t1_restricted from platform.orgs where id = ${orgId}`)[0];

  test("region at registration from the restricted list or INN prefix 90–95 → t1_restricted=true", async () => {
    const s = await devLogin(api, "region@example.ru");
    for (const code of ["90", "91", "92", "93", "94", "95"]) {
      const id = await newOrg(s, { name: `Регион ${code}`, regionCode: code });
      expect(await flags(id)).toEqual({ region_code: code, t1_restricted: true });
      expect((await s.req("GET", `/orgs/${id}/settings`)).body).toMatchObject({
        t1Restricted: true,
        buildModelLabel: "модели в РФ",
      });
    }
    const byInn = await newOrg(s, { name: "ИНН Крым", inn: inn10("91") });
    expect(await flags(byInn)).toEqual({ region_code: "91", t1_restricted: true });
    const moscow = await newOrg(s, { name: "Москва", inn: inn10("77") });
    expect(await flags(moscow)).toEqual({ region_code: "77", t1_restricted: false });
    expect((await s.req("GET", `/orgs/${moscow}/settings`)).body.t1Restricted).toBe(false);
    // INN of the requisites later: prefix 93 restricts; the flag never clears by the owner.
    const later = await s.req("PATCH", `/orgs/${moscow}`, { body: { inn: inn10("93") } });
    expect(later.status).toBe(200);
    expect(await flags(moscow)).toEqual({ region_code: "93", t1_restricted: true });
    await s.req("PATCH", `/orgs/${moscow}`, { body: { regionCode: "77" } });
    expect(await flags(moscow)).toEqual({ region_code: "77", t1_restricted: true });
    const bad = await s.req("POST", "/orgs", { body: { name: "Ошибка", inn: "7707083894" } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("INN_INVALID");
  });

  test("unknown region → T0 (t1Restricted=true) until determined (fail-safe)", async () => {
    const s = await devLogin(api, "unknown-region@example.ru");
    const [m] = (await s.req("GET", "/me")).body.memberships;
    expect(await flags(m.orgId)).toEqual({ region_code: null, t1_restricted: false });
    expect((await s.req("GET", `/orgs/${m.orgId}/settings`)).body).toMatchObject({
      t1Restricted: true,
      buildModelLabel: "модели в РФ",
    });
    await s.req("PATCH", `/orgs/${m.orgId}`, { body: { regionCode: "77" } });
    expect((await s.req("GET", `/orgs/${m.orgId}/settings`)).body.t1Restricted).toBe(false);
  });

  test("a login geolocated to a restricted region restricts every org of the user (GeoIP mock)", async () => {
    const s = await devLogin(api, "geo@example.ru");
    const id = await newOrg(s, { name: "Гео", regionCode: "77" });
    expect((await flags(id))?.t1_restricted).toBe(false);
    geo.set("unknown", "91"); // the in-process fetch has no peer address
    try {
      await devLogin(api, "geo@example.ru");
    } finally {
      geo.clear();
    }
    expect((await flags(id))?.t1_restricted).toBe(true);
  });
});

describe("members and invites", () => {
  test("invite → letter → the invitee signs in, accepts and sees the org's systems with the invited role", async () => {
    const owner = await devLogin(api, "team-owner@example.ru");
    const orgId = await newOrg(owner, { name: "Команда", regionCode: "77" });
    const sys = await owner.req("POST", "/systems", { body: { prompt: "Регистрация на форум", orgId } });
    expect(sys.status).toBe(201);
    await waitRun(owner, sys.body.run.id);

    const inv = await owner.req("POST", `/orgs/${orgId}/invites`, {
      body: { email: "Guest@Example.ru", role: "editor" },
    });
    expect(inv.status).toBe(201);
    expectContract("createInvite", inv);
    expect(new Date(inv.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    const list = await owner.req("GET", `/orgs/${orgId}/invites`);
    expectContract("listInvites", list);
    expect(list.body.items).toEqual([expect.objectContaining({ email: "guest@example.ru", role: "editor" })]);
    const token = mailer.inviteToken("guest@example.ru");
    expect(mailer.last("guest@example.ru", "invite")?.text).toContain(`${ORIGIN}/invite/${token}`);
    const [row] = await api.deps.pg`select token_hash from platform.invites where id = ${inv.body.id}`;
    expect(row?.token_hash).not.toBe(token);

    const stranger = await devLogin(api, "stranger@example.ru");
    const wrong = await stranger.req("POST", `/invites/${token}/accept`);
    expect(wrong.status).toBe(403);
    expectContract("acceptInvite", wrong);

    const guest = await otpLogin(api, mailer, "guest@example.ru");
    const acc = await guest.req("POST", `/invites/${token}/accept`);
    expect(acc.status).toBe(200);
    expectContract("acceptInvite", acc);
    expect(acc.body).toMatchObject({ userId: guest.userId, role: "editor", email: "guest@example.ru" });
    const again = await guest.req("POST", `/invites/${token}/accept`);
    expect(again.status).toBe(410);
    expect(again.body.code).toBe("INVITE_EXPIRED");

    const systems = await guest.req("GET", `/systems?orgId=${orgId}`);
    expect(systems.body.items.map((x: { id: string }) => x.id)).toEqual([sys.body.system.id]);
    const me = await guest.req("GET", "/me");
    expect(me.body.memberships).toEqual(
      expect.arrayContaining([{ orgId, orgName: "Команда", role: "editor" }]),
    );
    // A member of two orgs names the org when creating a system.
    expect((await guest.req("POST", "/systems", { body: { prompt: "Запись к мастеру" } })).status).toBe(400);
    const made = await guest.req("POST", "/systems", { body: { prompt: "Запись к мастеру", orgId } });
    expect(made.status).toBe(201);
    await waitRun(guest, made.body.run.id);

    const members = await guest.req("GET", `/orgs/${orgId}/members`);
    expectContract("listMembers", members);
    expect(members.body.items.map((m: { role: string }) => m.role).sort()).toEqual(["editor", "owner"]);
  });

  test("revoked, expired and unknown invites; repeated invite replaces the previous; member → 400", async () => {
    const owner = await devLogin(api, "inv-owner@example.ru");
    const orgId = await newOrg(owner);
    const first = await owner.req("POST", `/orgs/${orgId}/invites`, {
      body: { email: "x@example.ru", role: "viewer" },
    });
    const t1 = mailer.inviteToken("x@example.ru");
    const second = await owner.req("POST", `/orgs/${orgId}/invites`, {
      body: { email: "x@example.ru", role: "editor" },
    });
    const t2 = mailer.inviteToken("x@example.ru");
    expect(
      (await owner.req("GET", `/orgs/${orgId}/invites`)).body.items.map((i: { id: string }) => i.id),
    ).toEqual([second.body.id]);
    const x = await devLogin(api, "x@example.ru");
    expect((await x.req("POST", `/invites/${t1}/accept`)).status).toBe(410);
    const del = await owner.req("DELETE", `/orgs/${orgId}/invites/${second.body.id}`);
    expect(del.status).toBe(204);
    expect((await owner.req("DELETE", `/orgs/${orgId}/invites/${first.body.id}`)).status).toBe(404);
    expect((await x.req("POST", `/invites/${t2}/accept`)).status).toBe(410);

    await owner.req("POST", `/orgs/${orgId}/invites`, { body: { email: "x@example.ru", role: "viewer" } });
    const t3 = mailer.inviteToken("x@example.ru");
    await api.deps
      .pg`update platform.invites set expires_at = now() - interval '1 second' where org_id = ${orgId}`;
    expect((await x.req("POST", `/invites/${t3}/accept`)).status).toBe(410);
    expect((await x.req("POST", `/invites/${"A".repeat(43)}/accept`)).status).toBe(404);
    expect((await x.req("POST", "/invites/short/accept")).status).toBe(404);

    const member = await owner.req("POST", `/orgs/${orgId}/invites`, {
      body: { email: "inv-owner@example.ru", role: "viewer" },
    });
    expect(member.status).toBe(400);
  });

  test("members + active invites ≤ plan limit (Free: 3) → 402 PLAN_LIMIT {limit, current, plan}", async () => {
    const owner = await devLogin(api, "limit-owner@example.ru");
    const orgId = await newOrg(owner);
    for (const e of ["l1@example.ru", "l2@example.ru"])
      expect(
        (await owner.req("POST", `/orgs/${orgId}/invites`, { body: { email: e, role: "viewer" } })).status,
      ).toBe(201);
    const over = await owner.req("POST", `/orgs/${orgId}/invites`, {
      body: { email: "l3@example.ru", role: "viewer" },
    });
    expect(over.status).toBe(402);
    expectContract("createInvite", over);
    expect(over.body).toMatchObject({ code: "PLAN_LIMIT", details: { limit: 3, current: 3, plan: "free" } });
    await api.deps.pg`update platform.orgs set plan = 'start' where id = ${orgId}`;
    expect(
      (
        await owner.req("POST", `/orgs/${orgId}/invites`, {
          body: { email: "l3@example.ru", role: "viewer" },
        })
      ).status,
    ).toBe(201);
  });

  test("roles: change and remove; the last owner cannot leave or be demoted (LAST_OWNER)", async () => {
    const owner = await devLogin(api, "lo-owner@example.ru");
    const orgId = await newOrg(owner);
    const other = await devLogin(api, "lo-other@example.ru");
    await api.deps
      .pg`insert into platform.memberships (org_id, user_id, role) values (${orgId}, ${other.userId}, 'viewer')`;

    const demote = await owner.req("PATCH", `/orgs/${orgId}/members/${owner.userId}`, {
      body: { role: "editor" },
    });
    expect(demote.status).toBe(422);
    expect(demote.body.code).toBe("LAST_OWNER");
    expectContract("updateMemberRole", demote);
    const leave = await owner.req("DELETE", `/orgs/${orgId}/members/${owner.userId}`);
    expect(leave.status).toBe(422);
    expectContract("removeMember", leave);

    const up = await owner.req("PATCH", `/orgs/${orgId}/members/${other.userId}`, {
      body: { role: "owner" },
    });
    expect(up.status).toBe(200);
    expectContract("updateMemberRole", up);
    expect(up.body).toMatchObject({ userId: other.userId, role: "owner" });
    expect(
      (await owner.req("PATCH", `/orgs/${orgId}/members/${owner.userId}`, { body: { role: "viewer" } }))
        .status,
    ).toBe(200);
    // The former owner is a viewer now: owner-only operations → 403.
    expect((await owner.req("PATCH", `/orgs/${orgId}`, { body: { name: "Моя" } })).status).toBe(403);
    const rm = await other.req("DELETE", `/orgs/${orgId}/members/${owner.userId}`);
    expect(rm.status).toBe(204);
    expect((await owner.req("GET", `/orgs/${orgId}`)).status).toBe(404);
    expect((await other.req("DELETE", `/orgs/${orgId}/members/${owner.userId}`)).status).toBe(404);
    expect(
      (await other.req("PATCH", `/orgs/${orgId}/members/${other.userId}`, { body: { role: "boss" } })).status,
    ).toBe(400);
  });
});
