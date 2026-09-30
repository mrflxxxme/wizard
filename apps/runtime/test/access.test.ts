// DataAccess as the host of ctx.db / ctx.systemDb: @wizard/sdk/host createFunctionHost over DataAccess.runner().
import { quoteIdent } from "@wizard/appspec";
import { type CurrentUser, mutation, query, v } from "@wizard/sdk";
import { createFunctionHost, SYSTEM_USER } from "@wizard/sdk/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DataAccess, InvalidationEvent } from "../src/index.js";
import { forumSpec, type Harness, harness, login, seedRow, seedUser, userIdOf } from "./helpers.js";

type Table = {
  get(id: string): Promise<Record<string, unknown> | null>;
  getBy(field: string, value: unknown): Promise<Record<string, unknown> | null>;
  list(o?: {
    where?: Record<string, unknown>;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<Record<string, unknown>[]>;
  count(o?: { where?: Record<string, unknown> }): Promise<number>;
  paginate(
    o: { where?: Record<string, unknown> },
    p: { cursor: string | null; numItems: number },
  ): Promise<{ items: Record<string, unknown>[]; continueCursor: string | null; isDone: boolean }>;
  insert(doc: Record<string, unknown>): Promise<string>;
  patch(id: string, doc: Record<string, unknown>): Promise<void>;
};
type Db = { partner_quota: Table; ticket: Table; stream: Table };
const db = (x: unknown) => x as Db;

const spec = forumSpec();
const HOST = "acc--draft.localhost:4100";
let h: Harness;
let schema = "";
let data: DataAccess;
const user = (id: string, role: string, isAdmin = false) =>
  ({ id, role, attrs: {}, isAdmin }) as unknown as CurrentUser;

const functions = {
  // Same names/kinds as the forum spec (createFunctionHost resolves them against spec.functions).
  partnerQuota: query({
    args: {},
    handler: async (ctx) => ({
      mine: (await db(ctx.db).partner_quota.list()).length,
      all: await db(ctx.systemDb).partner_quota.count(),
    }),
  }),
  ticketAvailability: query({
    args: { id: v.optional(v.string()) },
    handler: async (ctx, args) => (args.id ? db(ctx.db).ticket.get(args.id) : null),
  }),
  registerTicket: mutation({
    args: { name: v.string(), limit: v.int(), fail: v.optional(v.boolean()) },
    handler: async (ctx, args) => {
      const n = await db(ctx.systemDb).stream.count();
      if (n >= args.limit) return null;
      const id = await db(ctx.systemDb).stream.insert({ name: args.name, capacity: 1 });
      const schedule = ctx.scheduler.runAfter as (ms: number, fn: string, a: unknown) => Promise<string>;
      await schedule(60_000, "partnerQuota", {});
      if (args.fail) throw ctx.error("BOOM", { message: "Отказ" });
      return id;
    },
  }),
};

beforeAll(async () => {
  h = await harness();
  ({ schema } = await h.system("acc", spec));
  const sys = await h.rt.systems.resolve("acc", "draft");
  if (!sys) throw new Error("system not loaded");
  data = sys.data;
  await login(h.rt, HOST, "partner");
  await login(h.rt, HOST, "volunteer");
});

afterAll(async () => {
  await h?.close();
});

const host = () =>
  createFunctionHost({
    spec,
    functions,
    transactions: data.runner(),
    retryDelay: async () => {},
    maxRetries: 5,
  });

describe("ctx.db acts as the caller, ctx.systemDb as __system", () => {
  it("rowFilter applies to ctx.db only; deps are recorded", async () => {
    const partner = await userIdOf(h.sql, schema, "partner");
    await seedRow(h.sql, schema, spec, "partner_quota", { partner_user: partner });
    await seedRow(h.sql, schema, spec, "partner_quota", {
      partner_user: await seedUser(h.sql, schema, "partner"),
    });
    const r = await host().call("partnerQuota", {}, { user: user(partner, "partner") });
    expect(r.result).toEqual({ mine: 1, all: 2 });
    expect(r.deps).toEqual(["partner_quota"]);
  });

  it("hidden fields are absent in ctx.db documents; foreign rows are null", async () => {
    const volunteer = await userIdOf(h.sql, schema, "volunteer");
    const t = await seedRow(h.sql, schema, spec, "ticket");
    const r = await host().call("ticketAvailability", { id: t }, { user: user(volunteer, "volunteer") });
    const doc = r.result as Record<string, unknown>;
    expect(doc.id).toBe(t);
    expect(doc).not.toHaveProperty("holder_name");
    expect(doc).toHaveProperty("status");
    const partner = await userIdOf(h.sql, schema, "partner");
    await expect(
      host().call("ticketAvailability", { id: t }, { user: user(partner, "partner") }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("mutation commits writes + outbox job, publishes after commit; failure rolls back everything", async () => {
    const seen: InvalidationEvent[] = [];
    const off = data.events.subscribe((e) => seen.push(e));
    const ok = await host().call(
      "registerTicket",
      { name: "Поток А", limit: 1000 },
      { user: SYSTEM_USER, via: "internal" },
    );
    const id = ok.result as string;
    expect(seen).toEqual([{ entity: "stream", id, op: "insert" }]);
    const jobs = await h.sql.unsafe(`select payload from ${quoteIdent(schema)}."_w_jobs"`);
    expect(jobs.map((j) => (j.payload as { name: string }).name)).toContain("partnerQuota");
    const before = jobs.length;
    seen.length = 0;
    await expect(
      host().call(
        "registerTicket",
        { name: "Откат", limit: 1000, fail: true },
        { user: SYSTEM_USER, via: "internal" },
      ),
    ).rejects.toMatchObject({ code: "BOOM" });
    off();
    expect(seen).toEqual([]);
    const rows = await h.sql.unsafe(
      `select count(*)::int as n from ${quoteIdent(schema)}."stream" where name = 'Откат'`,
    );
    expect(rows[0]?.n).toBe(0);
    expect((await h.sql.unsafe(`select 1 from ${quoteIdent(schema)}."_w_jobs"`)).length).toBe(before);
  });

  it("SERIALIZABLE: parallel mutations never exceed the invariant", async () => {
    const base = Number(
      (await h.sql.unsafe(`select count(*)::int as n from ${quoteIdent(schema)}."stream"`))[0]?.n,
    );
    const limit = base + 3;
    const calls = Array.from({ length: 10 }, (_, i) =>
      host()
        .call("registerTicket", { name: `P${i}`, limit }, { user: SYSTEM_USER, via: "internal" })
        .then(
          () => "ok",
          (e: { code?: string }) => e.code,
        ),
    );
    const outcomes = await Promise.all(calls);
    expect(outcomes.every((o) => o === "ok" || o === "CONFLICT")).toBe(true);
    const after = Number(
      (await h.sql.unsafe(`select count(*)::int as n from ${quoteIdent(schema)}."stream"`))[0]?.n,
    );
    expect(after).toBe(limit);
  });
});

describe("DataTx adapters", () => {
  it("where by index, order, paginate, getBy, readonly and write checks", async () => {
    const moderator = await seedUser(h.sql, schema, "moderator");
    for (const status of ["new", "new", "approved"])
      await seedRow(h.sql, schema, spec, "speaker_application", { status });
    const subject = data.subjectFor({ id: moderator, role: "moderator" });
    await data.transaction("read", subject, async (tx) => {
      const news = await tx.data.list("speaker_application", {
        where: { status: "new" },
        order: "desc",
        limit: 10,
      });
      expect(news.length).toBeGreaterThanOrEqual(2);
      expect(news.every((d) => d.status === "new" && !("phone" in d))).toBe(true);
      const p1 = await tx.data.paginate(
        "speaker_application",
        { order: "asc" },
        { cursor: null, numItems: 2 },
      );
      expect(p1.items).toHaveLength(2);
      expect(p1.isDone).toBe(false);
      const p2 = await tx.data.paginate(
        "speaker_application",
        { order: "asc" },
        { cursor: p1.continueCursor, numItems: 100 },
      );
      expect(p2.isDone).toBe(true);
      expect(new Set([...p1.items, ...p2.items].map((d) => d.id)).size).toBe(
        p1.items.length + p2.items.length,
      );
      await expect(
        tx.data.list("speaker_application", { where: { phone: "+7" }, order: "asc", limit: 1 }),
      ).rejects.toMatchObject({
        code: "FIELD_HIDDEN",
      });
      await expect(tx.data.list("payment", { order: "asc", limit: 1 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
    const organizer = data.subjectFor({ id: await seedUser(h.sql, schema, "organizer"), role: "organizer" });
    expect(organizer.isAdmin).toBe(true);
    const code = `PROMO${Date.now()}`;
    const partner = await seedUser(h.sql, schema, "partner");
    await data.transaction("write", organizer, async (tx) => {
      const tt = await tx.data.insert("ticket_type", { name: "VIP", kind: "vip", price: 100, capacity: 10 });
      const id = await tx.data.insert("partner_quota", {
        partner_user: partner,
        company: "ООО",
        promo_code: code,
        ticket_type: tt,
        total: 5,
      });
      expect((await tx.data.getBy("partner_quota", "promo_code", code))?.id).toBe(id);
      await expect(tx.data.patch("partner_quota", id, { used: 3 })).rejects.toMatchObject({
        code: "FIELD_READONLY",
      });
      await tx.system.patch("partner_quota", id, { used: 3 });
      expect((await tx.data.get("partner_quota", id))?.used).toBe(3);
    });
  });

  it("runner loads the users row: blocked users are rejected", async () => {
    const id = await seedUser(h.sql, schema, "participant");
    await h.sql.unsafe(`update ${quoteIdent(schema)}."users" set blocked_at = now() where id = $1`, [id]);
    await expect(data.runner().run("read", user(id, "participant"), async () => 1)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
