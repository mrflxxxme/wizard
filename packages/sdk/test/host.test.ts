// createTestHost executes specs/runtime/examples/functions with the forum permission matrix (sdk.md §2).
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { beforeAll, describe, expect, test } from "vitest";
import { createFunctionHost, type TransactionRunner, toErrorResponse } from "../src/host/index.js";
import { mutation, query, v, WizardError } from "../src/index.js";
import { createTestHost, type TestHost } from "../src/testing/index.js";
import { loadForum, materializeApp } from "./helpers/app.js";

const forum = loadForum();
let functions: Record<string, unknown>;

beforeAll(async () => {
  const dir = materializeApp("runtime", { target: "impl" });
  functions = {};
  for (const f of forum.functions ?? []) {
    const mod = (await import(join(dir, f.file))) as { default: unknown };
    functions[f.name] = mod.default;
  }
});

const NOW = "2026-10-01T09:00:00.000Z";

async function setup(opts: { capacity?: number } = {}) {
  // validate: false — forum.json may be ahead of @wizard/appspec's schema during spec audits.
  const host = createTestHost(forum, { functions, now: NOW, validate: false });
  const org = host.createUser("organizer");
  const [s1] = await host.seed("stream", [{ name: "e-com", capacity: opts.capacity ?? 2 }]);
  const [std, partnerType] = await host.seed("ticket_type", [
    { name: "Стандарт", kind: "standard", price: 9900, capacity: 100 },
    { name: "Партнёрский", kind: "partner", price: 0, capacity: 100 },
  ]);
  return { host, org, s1: s1 as string, std: std as string, partnerType: partnerType as string };
}

function register(host: TestHost, user: Parameters<TestHost["call"]>[2], args: Record<string, unknown>) {
  const a = { holderName: "Анна Тестова", holderEmail: "guest@example.test", ...args };
  return host.call("registerTicket", a, user, { consent: true }) as Promise<{
    ticketId: string;
    needsPayment: boolean;
  }>;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WizardError) return e.code;
    throw e;
  }
  return "OK";
}

describe("registerTicket (examples)", () => {
  test("AC1: third ticket over the stream capacity → STREAM_FULL", async () => {
    const { host, s1, std } = await setup();
    const [anna, boris, vera] = ["participant", "participant", "participant"].map((r) => host.createUser(r));
    const a = await register(host, anna as never, { ticketTypeId: std, streamId: s1 });
    expect(a.needsPayment).toBe(true);
    await register(host, boris as never, { ticketTypeId: std, streamId: s1 });
    expect(await codeOf(register(host, vera as never, { ticketTypeId: std, streamId: s1 }))).toBe(
      "STREAM_FULL",
    );
    const rows = host.rows("ticket");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "pending_payment", amount: 9900, holder_user: anna?.id });
    expect(rows[0]?.qr_token).toMatch(/^[A-Z2-7]{26}$/);
  });

  test("20 parallel registrations with capacity 5 create exactly 5 tickets (sdk.md §2.2)", async () => {
    const { host, s1, std } = await setup({ capacity: 5 });
    const users = Array.from({ length: 20 }, () => host.createUser("participant"));
    const codes = await Promise.all(
      users.map((u) => codeOf(register(host, u, { ticketTypeId: std, streamId: s1 }))),
    );
    expect(codes.filter((c) => c === "OK")).toHaveLength(5);
    expect(codes.filter((c) => c === "STREAM_FULL")).toHaveLength(15);
    expect(host.rows("ticket")).toHaveLength(5);
  });

  test("unpaid holds expire after 30 minutes", async () => {
    const { host, s1, std } = await setup({ capacity: 1 });
    await register(host, host.createUser("participant"), { ticketTypeId: std, streamId: s1 });
    const late = host.createUser("participant");
    expect(await codeOf(register(host, late, { ticketTypeId: std, streamId: s1 }))).toBe("STREAM_FULL");
    host.advance(31 * 60_000);
    expect(await codeOf(register(host, late, { ticketTypeId: std, streamId: s1 }))).toBe("OK");
  });

  test("promo code: free ticket via systemDb, quota counter, errors", async () => {
    const { host, s1, std, partnerType } = await setup();
    const pa = host.createUser("partner");
    await host.seed("partner_quota", [
      { partner_user: pa.id, company: "Альфа", promo_code: "ALFA10", ticket_type: std, total: 1 },
    ]);
    const anna = host.createUser("participant");
    const r = await register(host, anna, { ticketTypeId: std, streamId: s1, promoCode: "alfa10 " });
    expect(r.needsPayment).toBe(false);
    expect(host.rows("ticket")[0]).toMatchObject({ status: "issued", amount: 0 });
    expect(host.rows("partner_quota")[0]?.used).toBe(1);
    const boris = host.createUser("participant");
    expect(
      await codeOf(register(host, boris, { ticketTypeId: std, streamId: s1, promoCode: "ALFA10" })),
    ).toBe("QUOTA_EXHAUSTED");
    expect(await codeOf(register(host, boris, { ticketTypeId: std, streamId: s1, promoCode: "NOPE" }))).toBe(
      "PROMO_INVALID",
    );
    expect(await codeOf(register(host, boris, { ticketTypeId: partnerType, streamId: s1 }))).toBe(
      "PROMO_REQUIRED",
    );
  });

  test("collectsPii: participant needs _consent (compliance.yaml#consent)", async () => {
    const { host, s1, std } = await setup();
    const anna = host.createUser("participant");
    const a = {
      ticketTypeId: std,
      streamId: s1,
      holderName: "Анна Тестова",
      holderEmail: "guest@example.test",
    };
    const expected = (forum.functions?.find((f) => f.name === "registerTicket") as { collectsPii?: boolean })
      ?.collectsPii
      ? "CONSENT_REQUIRED"
      : "OK";
    expect(await codeOf(host.call("registerTicket", a, anna))).toBe(expected);
  });

  test("createTestHost validates the spec by default", () => {
    const broken = { ...forum, permissions: [{ role: "ghost", entity: "stream", ops: ["read"] }] };
    expect(() => createTestHost(broken)).toThrow(/invalid spec/);
  });

  test("roles and args are checked before the handler runs", async () => {
    const { host, s1, std } = await setup();
    const args = { ticketTypeId: std, streamId: s1 };
    expect(await codeOf(register(host, host.createUser("partner"), args))).toBe("FORBIDDEN");
    expect(await codeOf(register(host, host.anonymous("visitor"), args))).toBe("UNAUTHENTICATED");
    const anna = host.createUser("participant");
    const err = await register(host, anna, { ...args, holderEmail: "nope", streamId: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(WizardError);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.details.fields.map((f: { field: string }) => f.field).sort()).toEqual([
      "holderEmail",
      "streamId",
    ]);
    const missing = "00000fff-0000-4000-8000-000000000000";
    expect(await codeOf(register(host, anna, { ...args, streamId: missing }))).toBe("NOT_FOUND");
    expect(toErrorResponse(err)).toMatchObject({
      status: 422,
      body: { error: { code: "VALIDATION_FAILED" } },
    });
  });
});

describe("partnerQuota / ticketAvailability (examples)", () => {
  test("AC2: partner sees only own quota via ctx.db rowFilter; organizer sees all", async () => {
    const { host, std, org } = await setup();
    const pa = host.createUser("partner");
    const pb = host.createUser("partner");
    await host.seed("partner_quota", [
      { partner_user: pa.id, company: "Альфа", promo_code: "ALFA10", ticket_type: std, total: 10 },
      { partner_user: pb.id, company: "Бета", promo_code: "BETA10", ticket_type: std, total: 10, used: 3 },
    ]);
    const mine = (await host.call("partnerQuota", {}, pa)) as { promoCode: string; left: number }[];
    expect(mine).toEqual([expect.objectContaining({ promoCode: "ALFA10", left: 10, company: "Альфа" })]);
    const all = (await host.callRaw("partnerQuota", {}, org)) as {
      result: { left: number }[];
      deps: string[];
    };
    expect(all.result.map((q) => q.left)).toEqual([10, 7]);
    expect(all.deps).toEqual(["partner_quota"]);
    expect(await codeOf(host.call("partnerQuota", {}, host.createUser("participant")))).toBe("FORBIDDEN");
  });

  test("public availability counts seats through systemDb", async () => {
    const { host, s1, std } = await setup({ capacity: 10 });
    await register(host, host.createUser("participant"), { ticketTypeId: std, streamId: s1 });
    await host.seed("ticket_type", [{ name: "Архив", kind: "vip", price: 1, capacity: 5, active: false }]);
    const res = await host.callRaw("ticketAvailability", {}, host.anonymous("visitor"));
    const list = res.result as { name: string; left: number }[];
    expect(list.map((t) => [t.name, t.left])).toEqual([
      ["Стандарт", 99],
      ["Партнёрский", 100],
    ]);
    expect(res.deps.sort()).toEqual(["ticket", "ticket_type"]);
  });

  test("sendReminder is internal: connector call recorded, not callable via API", async () => {
    const { host, s1, std } = await setup();
    const anna = host.createUser("participant");
    const { ticketId } = await register(host, anna, { ticketTypeId: std, streamId: s1 });
    const args = { ticketId, userId: anna.id, startsAt: "2026-11-14T06:30:00.000Z" };
    expect(await codeOf(host.call("sendReminder", args, anna))).toBe("NOT_FOUND");
    const r = await host.callRaw("sendReminder", args, anna, "internal");
    expect(r.result).toEqual({ delivered: true });
    expect(host.connectorCalls).toEqual([
      {
        integration: "telegram",
        method: "sendToUser",
        input: expect.objectContaining({ userId: anna.id, idempotencyKey: `reminder:${ticketId}` }),
      },
    ]);
  });
});

describe("ctx.db permissions (sdk.md §2.3)", () => {
  test("participant sees only own tickets via db; systemDb sees all; visitor is forbidden", async () => {
    const { host, s1, std } = await setup({ capacity: 10 });
    const anna = host.createUser("participant");
    const boris = host.createUser("participant");
    const { ticketId: annaTicket } = await register(host, anna, { ticketTypeId: std, streamId: s1 });
    const { ticketId: borisTicket } = await register(host, boris, { ticketTypeId: std, streamId: s1 });
    const seen = await host.run(anna, async (db, systemDb) => ({
      own: (await db.ticket?.list())?.map((t) => t.id),
      other: await db.ticket?.get(borisTicket),
      all: await systemDb.ticket?.count(),
    }));
    expect(seen).toEqual({ own: [annaTicket], other: null, all: 2 });
    expect(await codeOf(host.run(host.anonymous("visitor"), async (db) => db.ticket?.list()))).toBe(
      "FORBIDDEN",
    );
  });

  test("hiddenFields are absent from documents and cannot be used", async () => {
    const { host, s1, std } = await setup();
    await register(host, host.createUser("participant"), { ticketTypeId: std, streamId: s1 });
    const vol = host.createUser("volunteer");
    const [doc] = (await host.run(vol, async (db) => db.ticket?.list())) ?? [];
    expect(doc).toBeDefined();
    expect(Object.keys(doc ?? {})).not.toContain("holder_name");
    expect(Object.keys(doc ?? {})).not.toContain("qr_token");
    expect(doc).toHaveProperty("status", "pending_payment");
  });

  test("create: rowFilter columns are forced, readonly/hidden/unknown fields rejected", async () => {
    const { host } = await setup();
    const sp = host.createUser("speaker");
    const other = host.createUser("speaker");
    const app = { full_name: "Спикер Один", email: "s1@example.test", topic: "Ценники", abstract: "Кейс" };
    const id = await host.run(sp, async (db) => db.speaker_application?.insert(app));
    expect(host.rows("speaker_application")[0]).toMatchObject({
      speaker_user: sp.id,
      status: "new",
      created_by: sp.id,
    });
    const ins = (u: typeof sp, doc: Record<string, unknown>) =>
      codeOf(host.run(u, async (db) => db.speaker_application?.insert(doc)));
    expect(await ins(sp, { ...app, speaker_user: other.id })).toBe("FORBIDDEN");
    expect(await ins(sp, { ...app, status: "approved" })).toBe("FIELD_READONLY");
    expect(await ins(sp, { ...app, color: "red" })).toBe("UNKNOWN_FIELD");
    expect(await ins(sp, { ...app, created_at: NOW })).toBe("FIELD_READONLY");
    expect(await ins(sp, { ...app, email: "bad" })).toBe("VALIDATION_FAILED");
    const vol = host.createUser("volunteer");
    const [ticket] = await host.seed("ticket", []);
    expect(ticket).toBeUndefined();
    expect(
      await codeOf(host.run(vol, async (db) => db.checkin?.insert({ ticket: "x", qr_token: "y" }))),
    ).toBe("UNKNOWN_FIELD");
    // AC3: another speaker neither lists nor gets it; update/delete outside rowFilter → NOT_FOUND.
    const view = await host.run(other, async (db) => ({
      n: await db.speaker_application?.count(),
      one: await db.speaker_application?.get(id as string),
    }));
    expect(view).toEqual({ n: 0, one: null });
    expect(
      await codeOf(
        host.run(other, async (db) => db.speaker_application?.patch(id as string, { topic: "x" })),
      ),
    ).toBe("NOT_FOUND");
    const mod = host.createUser("moderator");
    expect(
      await codeOf(
        host.run(mod, async (db) => db.speaker_application?.patch(id as string, { phone: "+79990000000" })),
      ),
    ).toBe("FIELD_HIDDEN");
    await host.run(mod, async (db) => db.speaker_application?.patch(id as string, { status: "approved" }));
    expect(host.rows("speaker_application")[0]).toMatchObject({ status: "approved", updated_at: NOW });
    expect(host.events.filter((e) => e.entity === "speaker_application").map((e) => e.op)).toEqual([
      "insert",
      "update",
    ]);
  });

  test("rowFilterOps: rowFilter applies only to the listed ops", async () => {
    const spec = structuredClone(forum) as AppSpec;
    const perm = spec.permissions.find((p) => p.role === "speaker" && p.entity === "speaker_application");
    Object.assign(perm as object, { rowFilterOps: ["update"] });
    const host = createTestHost(spec, { validate: false, now: NOW });
    const s1 = host.createUser("speaker");
    const s2 = host.createUser("speaker");
    const app = { full_name: "Спикер", email: "s@example.test", topic: "Тема", abstract: "Текст" };
    const id = (await host.run(s1, async (db) =>
      db.speaker_application?.insert({ ...app, speaker_user: s1.id }),
    )) as string;
    expect(await host.run(s2, async (db) => db.speaker_application?.count())).toBe(1);
    expect(await codeOf(host.run(s2, async (db) => db.speaker_application?.patch(id, { topic: "x" })))).toBe(
      "NOT_FOUND",
    );
    await host.run(s1, async (db) => db.speaker_application?.patch(id, { topic: "Новая" }));
    expect(
      await codeOf(host.run(s1, async (db) => db.speaker_application?.patch(id, { speaker_user: s2.id }))),
    ).toBe("FORBIDDEN");
  });

  test("unique, ref and restrict are enforced", async () => {
    const { host, std, s1 } = await setup();
    const pa = host.createUser("partner");
    const quota = { partner_user: pa.id, company: "Альфа", promo_code: "ALFA10", ticket_type: std, total: 1 };
    await host.seed("partner_quota", [quota]);
    expect(await codeOf(host.seed("partner_quota", [quota]))).toBe("CONFLICT");
    expect(
      await codeOf(host.seed("partner_quota", [{ ...quota, promo_code: "X", partner_user: "nobody" }])),
    ).toBe("VALIDATION_FAILED");
    await register(host, host.createUser("participant"), { ticketTypeId: std, streamId: s1 });
    expect(await codeOf(host.run(host.createUser("organizer"), async (db) => db.stream?.delete(s1)))).toBe(
      "CONFLICT",
    );
  });
});

describe("executor semantics", () => {
  const spec = (fns: { name: string; kind: "query" | "mutation" | "action" }[]): AppSpec => ({
    ...forum,
    functions: fns.map((f) => ({ ...f, file: `functions/${f.name}.ts`, public: true, roles: ["organizer"] })),
  });

  test("limits: list size, writes in queries, reads, writes, ctx.error code format", async () => {
    const fns = {
      bigList: query({
        args: {},
        handler: async (ctx) => (ctx.db as never as Db).stream.list({ limit: 101 }),
      }),
      writeInQuery: query({
        args: {},
        handler: async (ctx) => (ctx.db as never as Db).stream.insert({ name: "x", capacity: 1 }),
      }),
      manyReads: query({
        args: {},
        handler: async (ctx) => {
          const db = ctx.db as never as Db;
          for (let i = 0; i < 5; i++) await db.stream.list({ limit: 100 });
        },
      }),
      manyWrites: mutation({
        args: { n: v.int() },
        handler: async (ctx, { n }) => {
          for (let i = 0; i < n; i++)
            await (ctx.db as never as Db).stream.insert({ name: `s${i}`, capacity: 1 });
        },
      }),
      badCode: mutation({ args: {}, handler: async (ctx) => Promise.reject(ctx.error("lower")) }),
      appError: mutation({
        args: {},
        handler: async (ctx) => Promise.reject(ctx.error("STREAM_FULL", { message: "Мест нет" })),
      }),
    };
    const host = createTestHost(spec(Object.entries(fns).map(([name, f]) => ({ name, kind: f.kind }))), {
      functions: fns,
      limits: { maxReads: 450 },
      validate: false,
    });
    const org = host.createUser("organizer");
    await host.seed(
      "stream",
      Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, capacity: 1 })),
    );
    expect(await codeOf(host.call("bigList", {}, org))).toBe("LIMIT_EXCEEDED");
    expect(await codeOf(host.call("writeInQuery", {}, org))).toBe("FORBIDDEN");
    expect(await codeOf(host.call("manyReads", {}, org))).toBe("LIMIT_EXCEEDED");
    expect(await codeOf(host.call("manyWrites", { n: 501 }, org))).toBe("LIMIT_EXCEEDED");
    expect(host.rows("stream")).toHaveLength(100); // rolled back
    await host.call("manyWrites", { n: 3 }, org);
    expect(host.rows("stream")).toHaveLength(103);
    expect(await codeOf(host.call("badCode", {}, org))).toBe("INTERNAL");
    const e = await host.call("appError", {}, org).catch((x) => x);
    expect(toErrorResponse(e)).toEqual({
      status: 400,
      body: { error: { code: "STREAM_FULL", message: "Мест нет", details: {} } },
    });
    expect(toErrorResponse(new Error("boom")).status).toBe(500);
  });

  test("scheduler writes to the transaction outbox and jobs run as __system", async () => {
    const seen: unknown[] = [];
    const fns = {
      plan: mutation({
        args: { fail: v.boolean() },
        handler: async (ctx, { fail }) => {
          await ctx.scheduler.runAfter(60_000, "work" as never, { n: 1 } as never);
          if (fail) throw ctx.error("NOPE_NOPE");
          return null;
        },
      }),
      work: mutation({
        args: { n: v.int() },
        handler: async (ctx, { n }) => {
          seen.push({ n, role: ctx.user.role });
        },
      }),
    };
    const host = createTestHost(
      spec([
        { name: "plan", kind: "mutation" },
        { name: "work", kind: "mutation" },
      ]),
      { functions: fns, now: NOW, validate: false },
    );
    const org = host.createUser("organizer");
    await codeOf(host.call("plan", { fail: true }, org));
    expect(host.jobs()).toHaveLength(0);
    await host.call("plan", { fail: false }, org);
    expect(host.jobs()).toHaveLength(1);
    expect(await host.runDueJobs()).toEqual([]);
    host.advance(60_000);
    expect(await host.runDueJobs()).toMatchObject([{ name: "work", ok: true }]);
    expect(seen).toEqual([{ n: 1, role: "__system" }]);
    expect(host.jobs()).toHaveLength(0);
  });

  test("serialization failures are retried up to 3 times, then CONFLICT", async () => {
    let failures = 0;
    let calls = 0;
    const runner: TransactionRunner = {
      async run(_mode, _user, fn) {
        calls += 1;
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("serialization"), { code: "40001" });
        }
        return fn({
          db: {} as never,
          systemDb: {} as never,
          scheduler: {} as never,
          now: new Date(NOW),
        });
      },
    };
    const fns = { m: mutation({ args: {}, handler: async () => 42 }) };
    const fh = createFunctionHost({
      spec: spec([{ name: "m", kind: "mutation" }]),
      functions: fns,
      transactions: runner,
      retryDelay: async () => {},
    });
    const user = { id: null, role: "__system", attrs: {}, isAdmin: false } as never;
    failures = 3;
    expect((await fh.call("m", {}, { user, via: "internal" })).result).toBe(42);
    expect(calls).toBe(4);
    failures = 4;
    calls = 0;
    expect(await codeOf(fh.call("m", {}, { user, via: "internal" }))).toBe("CONFLICT");
    expect(calls).toBe(4);
  });
});

type Db = Record<
  string,
  {
    list(o?: { limit?: number }): Promise<unknown[]>;
    insert(d: Record<string, unknown>): Promise<string>;
  }
> & {
  stream: {
    list(o?: { limit?: number }): Promise<unknown[]>;
    insert(d: Record<string, unknown>): Promise<string>;
  };
};
