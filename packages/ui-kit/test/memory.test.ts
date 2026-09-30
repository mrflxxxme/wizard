// createMemoryDataSource: runtime permission semantics (runtime.yaml#permissions) for demo and tests.
import { describe, expect, test } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { can, toRoleSpec } from "../src/index.js";
import { createMemoryDataSource } from "../src/testing/index.js";

const make = (userId: string | null) => {
  const f = forumFixture();
  return createMemoryDataSource(forum, f.rows, { users: f.users, functions: f.functions, userId });
};
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as { code: string }).code;
  }
};

describe("toRoleSpec", () => {
  test("removes hiddenFields, keeps own permissions and pages", () => {
    const s = toRoleSpec(forum, "moderator");
    const app = s.entities.find((e) => e.name === "speaker_application");
    expect(app?.fields.map((f) => f.name)).not.toContain("phone");
    expect(s.permissions.every((p) => p.role === "moderator")).toBe(true);
    expect(s.pages.map((p) => p.route)).toEqual(["/", "/moderation"]);
    expect(s.loginMethods).toEqual(["email_otp", "phone_otp", "telegram"]);
    expect(toRoleSpec(forum, null).role).toBe("visitor");
    expect(toRoleSpec(forum, null, { phoneOtp: false }).loginMethods).not.toContain("phone_otp");
  });

  test("can() follows ops, readonlyFields and hidden fields", () => {
    const mod = toRoleSpec(forum, "moderator");
    expect(can(mod, "update", "speaker_application")).toBe(true);
    expect(can(mod, "update", "speaker_application", "status")).toBe(true);
    expect(can(mod, "update", "speaker_application", "topic")).toBe(false);
    expect(can(mod, "read", "speaker_application", "phone")).toBe(false);
    expect(can(mod, "delete", "speaker_application")).toBe(false);
    const spk = toRoleSpec(forum, "speaker");
    expect(can(spk, "update", "speaker_application", "status")).toBe(false);
    expect(can(spk, "update", "speaker_application", "speaker_user")).toBe(false);
  });
});

describe("memory DataSource permissions", () => {
  test("ops: missing read → FORBIDDEN, guest without public permission → UNAUTHENTICATED", () => {
    expect(code(() => make("u_participant").list("speaker_application"))).toBe("FORBIDDEN");
    expect(code(() => make(null).list("ticket"))).toBe("UNAUTHENTICATED");
    expect(make(null).list("ticket_type").total).toBe(3);
  });

  test("rowFilter by $user.id: participant sees only own tickets, others are NOT_FOUND", () => {
    const ds = make("u_participant");
    const own = ds.list("ticket");
    expect(own.total).toBe(1);
    expect(own.items[0]?.holder_user).toBe("u_participant");
    expect(code(() => ds.get("ticket", "ticket_002"))).toBe("NOT_FOUND");
  });

  test("hiddenFields: key absent in list and get; filter/sort by hidden → FIELD_HIDDEN", () => {
    const ds = make("u_moderator");
    const { items } = ds.list("speaker_application", { pageSize: 5 });
    expect(items).toHaveLength(5);
    for (const r of items) expect(Object.hasOwn(r, "phone")).toBe(false);
    expect(Object.hasOwn(ds.get("speaker_application", "app_001"), "phone")).toBe(false);
    expect(code(() => ds.list("speaker_application", { filter: { phone: "+7" } }))).toBe("FIELD_HIDDEN");
    expect(code(() => ds.list("speaker_application", { sort: { field: "phone", dir: "asc" } }))).toBe(
      "FIELD_HIDDEN",
    );
  });

  test("readonlyFields and qr_token → FIELD_READONLY; unknown → UNKNOWN_FIELD", () => {
    const mod = make("u_moderator");
    expect(code(() => mod.update("speaker_application", "app_001", { topic: "x" }))).toBe("FIELD_READONLY");
    expect(code(() => mod.update("speaker_application", "app_001", { status: "approved" }))).toBe("ok");
    expect(code(() => mod.update("speaker_application", "app_001", { nope: 1 }))).toBe("UNKNOWN_FIELD");
    const org = make("u_organizer");
    expect(code(() => org.update("ticket", "ticket_001", { qr_token: "x" }))).toBe("FIELD_READONLY");
  });

  test("create: rowFilter field is forced, consent required for pii by non-admin, validation per field", () => {
    const ds = make("u_speaker");
    const values = {
      full_name: "Мария Ким",
      email: "maria@demo.example",
      phone: "+79005554433",
      topic: "Склад",
      abstract: "Кейс",
    };
    expect(code(() => ds.create("speaker_application", values))).toBe("CONSENT_REQUIRED");
    const row = ds.create("speaker_application", values, { consent: true });
    expect(row.speaker_user).toBe("u_speaker");
    expect(
      code(() => ds.create("speaker_application", { ...values, speaker_user: "u_other" }, { consent: true })),
    ).toBe("FORBIDDEN");
    try {
      ds.create("speaker_application", { ...values, email: "bad" }, { consent: true });
    } catch (e) {
      expect(e).toMatchObject({ code: "VALIDATION_FAILED", status: 422, fields: [{ field: "email" }] });
    }
    expect(ds.calls.filter((c) => c.op === "create")).toHaveLength(4);
  });

  test("list: filters, sort, pagination (60 records, page 3 of 25 → 10)", () => {
    const ds = make("u_organizer");
    expect(ds.list("speaker_application", { pageSize: 25, page: 3 }).items).toHaveLength(10);
    const onlyNew = ds.list("speaker_application", { filter: { status: "new" }, pageSize: 100 });
    expect(onlyNew.items.every((r) => r.status === "new")).toBe(true);
    expect(onlyNew.total).toBe(20);
    const asc = ds.list("speaker_application", {
      sort: { field: "created_at", dir: "asc" },
      pageSize: 100,
    }).items;
    expect(asc.map((r) => r.created_at)).toEqual([...asc.map((r) => r.created_at)].sort());
    const all = ds.list("speaker_application", { pageSize: 100 }).items;
    const byName = all.filter((r) => String(r.full_name).includes("Иванова")).length;
    expect(byName).toBeGreaterThan(0);
    expect(ds.list("speaker_application", { search: "иванова", pageSize: 100 }).total).toBe(byName);
    expect(code(() => ds.list("speaker_application", { pageSize: 101 }))).toBe("VALIDATION_FAILED");
  });

  test("auth: OTP via dev-sender outbox logs in an existing user by phone, a new one by email (selfSignup)", async () => {
    const f = forumFixture();
    const ds = createMemoryDataSource(forum, f.rows, { users: f.users });
    const { challengeId } = await ds.auth.start("phone", "+79001234510");
    const sent = ds.outbox.at(-1);
    expect(sent).toMatchObject({ channel: "phone", destination: "+79001234510" });
    await expect(ds.auth.verify(challengeId, "000000")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await ds.auth.verify(challengeId, sent?.code ?? "")).role).toBe("participant");
    expect(ds.getUser()?.id).toBe("u_participant");
    const second = await ds.auth.start("email", "new@demo.example");
    const u = await ds.auth.verify(second.challengeId, ds.outbox.at(-1)?.code ?? "");
    expect(u.role).toBe("speaker");
  });

  test("qr check: ok → duplicate (with first scan time) → invalid for garbage and wrong status", () => {
    const ds = make("u_volunteer");
    const token = String(ds.rows("ticket")[0]?.qr_token);
    const first = ds.qrCheck({ payload: token, checkpoint: "Вход А", deviceId: "d1" });
    expect(first).toMatchObject({ status: "ok", ticketTitle: "Стандарт · Логистика" });
    expect(ds.qrCheck({ payload: token, deviceId: "d1" })).toMatchObject({
      status: "duplicate",
      firstScannedAt: first.scannedAt,
      firstCheckpoint: "Вход А",
    });
    expect(ds.qrCheck({ payload: "мусор", deviceId: "d1" })).toMatchObject({
      status: "invalid",
      reason: "not_found",
    });
    const org = make("u_organizer");
    org.update("ticket", "ticket_001", { status: "canceled" });
    expect(org.qrCheck({ payload: token, deviceId: "d1" })).toMatchObject({ reason: "not_valid_status" });
  });
});
