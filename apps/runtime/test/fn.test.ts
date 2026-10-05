// backlog M0-23: /api/fn over the isolated executor — examples, roles/public/consent, limits, SERIALIZABLE retries,
// ctx.db vs ctx.systemDb, scheduler → _w_jobs, escape attempts (security/isolation.yaml#escape_tests.M0).
import { quoteIdent } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceInfo } from "../src/index.js";
import { type ExecHarness, type ExecSystem, type ExtraFunction, execHarness } from "./exec-helpers.js";
import { login, request, seedRow, userIdOf } from "./helpers.js";

const ALL = ["visitor", "participant", "speaker", "partner", "moderator", "volunteer", "organizer"];

const EXTRA: ExtraFunction[] = [
  {
    name: "escapeProbe",
    kind: "query",
    roles: ALL,
    source: `import { query } from "@wizard/sdk";
const probe = (f) => { try { const p = f(); return p && typeof p === "object" && "pid" in p ? "LEAK" : typeof p; } catch (e) { return "blocked:" + (e && e.name); } };
export default query({ args: {}, handler: async function (ctx) {
  const self = this;
  const mod = "node:" + "fs";
  let dyn = "LEAK";
  try { await import(mod); } catch { dyn = "blocked"; }
  return {
    thisCtor: probe(() => self.constructor.constructor("return process")()),
    ctxCtor: probe(() => ctx.constructor.constructor("return process")()),
    dbCtor: probe(() => ctx.db.ticket.get.constructor("return process")()),
    userCtor: probe(() => ctx.user.constructor.constructor("return process")()),
    globalCtor: probe(() => globalThis.constructor.constructor("return process")()),
    asyncCtor: probe(() => (async () => {}).constructor("return process")()),
    evalStr: probe(() => (0, eval)("1 + 1")),
    process: typeof globalThis.process,
    fetch: typeof globalThis.fetch,
    require: typeof globalThis.require,
    Buffer: typeof globalThis.Buffer,
    setTimeout: typeof globalThis.setTimeout,
    console: typeof globalThis.console,
    WebAssembly: typeof globalThis.WebAssembly,
    dyn,
  };
}});`,
  },
  {
    name: "callFetch",
    kind: "query",
    roles: ALL,
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async () => { const r = await fetch("https://example.com"); return r.status; } });`,
  },
  {
    name: "loopForever",
    kind: "query",
    roles: ALL,
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async () => { for (;;) {} } });`,
  },
  {
    name: "loopAction",
    kind: "action",
    roles: ALL,
    source: `import { action } from "@wizard/sdk";
export default action({ args: {}, handler: async () => { let x = 0; while (x >= 0) x = (x + 1) % 1000; return x; } });`,
  },
  {
    name: "readMany",
    kind: "query",
    roles: ["organizer"],
    source: `import { query, v } from "@wizard/sdk";
export default query({ args: { extra: v.boolean(), swallow: v.optional(v.boolean()) }, handler: async (ctx, a) => {
  let n = 0;
  for (let i = 0; i < 40; i++) n += (await ctx.systemDb.stream.list({ limit: 100 })).length;
  if (a.extra) {
    try { await ctx.systemDb.stream.first(); n += 1; } catch (e) { if (!a.swallow) throw e; }
  }
  return n;
}});`,
  },
  {
    name: "ticketsSeen",
    kind: "query",
    roles: ["participant"],
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async (ctx) => ({
  db: (await ctx.db.ticket.list({ limit: 100 })).length,
  system: (await ctx.systemDb.ticket.list({ limit: 100 })).length,
}) });`,
  },
  {
    name: "scheduleJob",
    kind: "mutation",
    roles: ["organizer"],
    source: `import { mutation, v } from "@wizard/sdk";
export default mutation({ args: { fail: v.boolean(), tag: v.string() }, handler: async (ctx, a) => {
  const id = await ctx.scheduler.runAfter(60000, "sendReminder", { tag: a.tag });
  if (a.fail) throw ctx.error("ROLLED_BACK", { message: "Откат" });
  return id;
}});`,
  },
  {
    name: "appError",
    kind: "mutation",
    roles: ALL,
    source: `import { mutation } from "@wizard/sdk";
export default mutation({ args: {}, handler: async (ctx) => { throw ctx.error("CUSTOM_FAIL"); } });`,
  },
  {
    name: "queryWrites",
    kind: "query",
    roles: ["organizer"],
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async (ctx) => ctx.db.stream.insert({ name: "x", capacity: 1 }) });`,
  },
  {
    name: "adminOnly",
    kind: "query",
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async (ctx) => ({ role: ctx.user.role, attrs: ctx.user.attrs }) });`,
  },
  {
    name: "nestedAction",
    kind: "action",
    roles: ["organizer"],
    source: `import { action } from "@wizard/sdk";
export default action({ args: {}, handler: async (ctx) => {
  const avail = await ctx.runQuery("ticketAvailability", {});
  const sent = await ctx.connectors.telegram.sendToUser({ userId: ctx.user.id, text: "Привет" });
  let egress = "open";
  try { await ctx.http.fetch("https://example.com"); } catch (e) { egress = e.code; }
  return { types: avail.length, delivered: sent.delivered, egress };
}});`,
  },
];

let h: ExecHarness;
let sys: ExecSystem;
const cookie: Record<string, string> = {};
const c = () => complianceInfo(sys.spec);
const consent = () => ({ policyVersion: c().policyVersion, textHash: c().consentTextHash });

// Loose view of JSON responses in assertions.
// biome-ignore lint/suspicious/noExplicitAny: test-only access to arbitrary response shapes
type Body = Record<string, any>;

async function call(name: string, args: unknown, role?: string, extra: Record<string, unknown> = {}) {
  const res = await h.rt.fetch(
    request("POST", sys.host, `/api/fn/${name}`, {
      cookie: role ? cookie[role] : undefined,
      body: { args, ...extra },
    }),
  );
  return { status: res.status, body: (await res.json()) as Body };
}

beforeAll(async () => {
  h = await execHarness();
  sys = await h.fnSystem("fnx", EXTRA);
  for (const r of ["organizer", "participant", "partner"]) cookie[r] = await login(h.rt, sys.host, r);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("examples via /api/fn", () => {
  it("ticketAvailability (public role) returns data and deps", async () => {
    await seedRow(h.sql, sys.schema, sys.spec, "ticket_type", {
      kind: "standard",
      active: true,
      capacity: 10,
    });
    const r = await call("ticketAvailability", {});
    expect(r.status).toBe(200);
    expect(r.body.result.length).toBeGreaterThan(0);
    expect(r.body.result[0]).toMatchObject({ kind: "standard" });
    expect(r.body.deps).toEqual(expect.arrayContaining(["ticket_type", "ticket"]));
  });

  it("partnerQuota runs for partner and organizer, 403 for participant", async () => {
    expect((await call("partnerQuota", {}, "partner")).status).toBe(200);
    expect((await call("partnerQuota", {}, "organizer")).status).toBe(200);
    expect((await call("partnerQuota", {}, "participant")).body.error.code).toBe("FORBIDDEN");
  });

  it("registerTicket: consent, validation, roles, app errors", async () => {
    const stream = await seedRow(h.sql, sys.schema, sys.spec, "stream", { capacity: 1 });
    const type = await seedRow(h.sql, sys.schema, sys.spec, "ticket_type", {
      kind: "standard",
      active: true,
      capacity: 10,
    });
    const args = {
      ticketTypeId: type,
      streamId: stream,
      holderName: "Анна Тестова",
      holderEmail: "a@example.test",
    };
    expect((await call("registerTicket", args, "participant")).body.error.code).toBe("CONSENT_REQUIRED");
    const wrong = { _consent: { policyVersion: "x", textHash: "y" } };
    expect((await call("registerTicket", args, "participant", wrong)).body.error.code).toBe(
      "CONSENT_REQUIRED",
    );
    const bad = await call("registerTicket", { ...args, holderEmail: "nope" }, "participant", {
      _consent: consent(),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
    expect((await call("registerTicket", args, undefined, { _consent: consent() })).status).toBe(401);
    expect((await call("registerTicket", args, "organizer", { _consent: consent() })).status).toBe(403);
    const ok = await call("registerTicket", args, "participant", { _consent: consent() });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toMatchObject({ needsPayment: true });
    // M2-05: an accepted collectsPii call is journaled in _w_consents (entity fn:<name>, row_id = caller).
    const journal = await h.sql.unsafe(
      `select row_id::text as row_id, policy_version from ${quoteIdent(sys.schema)}."_w_consents" where entity = 'fn:registerTicket'`,
    );
    expect(journal).toEqual([
      { row_id: await userIdOf(h.sql, sys.schema, "participant"), policy_version: c().policyVersion },
    ]);
    const full = await call("registerTicket", args, "participant", { _consent: consent() });
    expect(full.status).toBe(400);
    expect(full.body.error.code).toBe("STREAM_FULL");
    expect(full.body.error.message).toMatch(/не осталось мест/);
  });

  it("non-public and unknown functions → 404; no roles → only isAdmin roles", async () => {
    expect((await call("sendReminder", {}, "organizer")).status).toBe(404);
    expect((await call("nope", {}, "organizer")).status).toBe(404);
    expect((await call("adminOnly", {}, "participant")).status).toBe(403);
    const admin = await call("adminOnly", {}, "organizer");
    expect(admin.status).toBe(200);
    expect(admin.body.result.role).toBe("organizer");
    expect(admin.body.result.attrs).not.toHaveProperty("email");
  });

  it("ctx.error without message → 400 with the default message", async () => {
    const r = await call("appError", {}, "organizer");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "CUSTOM_FAIL", message: "Операция отклонена" });
  });

  it("GET /api/fn/:name is not a function call", async () => {
    const res = await h.rt.fetch(request("GET", sys.host, "/api/fn/ticketAvailability"));
    expect(res.status).toBe(404);
  });
});

describe("isolation", () => {
  it("vm escapes via constructor chains, eval, dynamic import and host globals fail", async () => {
    const r = await call("escapeProbe", {}, "organizer");
    expect(r.status).toBe(200);
    const res = r.body.result as Record<string, string>;
    for (const k of ["thisCtor", "ctxCtor", "dbCtor", "userCtor", "globalCtor", "asyncCtor", "evalStr"]) {
      expect(res[k], k).toBe("blocked:EvalError");
    }
    expect(res).toMatchObject({
      process: "undefined",
      fetch: "undefined",
      require: "undefined",
      Buffer: "undefined",
      setTimeout: "undefined",
      console: "undefined",
      WebAssembly: "undefined",
      dyn: "blocked",
    });
  });

  it("fetch is unavailable inside functions", async () => {
    const r = await call("callFetch", {}, "organizer");
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("INTERNAL");
  });

  it("an infinite loop in a query is stopped (≤ 5 s) with 504 TIMEOUT, then the next call works", async () => {
    const t0 = Date.now();
    const r = await call("loopForever", {}, "organizer");
    const ms = Date.now() - t0;
    expect(r.status).toBe(504);
    expect(r.body.error.code).toBe("TIMEOUT");
    expect(ms).toBeLessThan(5000);
    expect((await call("ticketAvailability", {})).status).toBe(200);
  });

  it("an infinite loop in an action is killed at the 5 s ceiling", async () => {
    const t0 = Date.now();
    const r = await call("loopAction", {}, "organizer");
    const ms = Date.now() - t0;
    expect(r.body.error.code).toBe("TIMEOUT");
    expect(ms).toBeGreaterThanOrEqual(4900);
    expect(ms).toBeLessThan(6500);
  });
});

describe("limits and transactions", () => {
  it("4000 reads pass; the 4001st → 422 LIMIT_EXCEEDED even if the function catches it", async () => {
    await h.sql.unsafe(
      `insert into "${sys.schema}"."stream" (id, name, capacity) select gen_random_uuid(), 'bulk ' || g, 5 from generate_series(1, 100) g`,
    );
    const n = Number((await h.sql.unsafe(`select count(*)::int as n from "${sys.schema}"."stream"`))[0]?.n);
    expect(n).toBeGreaterThanOrEqual(100);
    const ok = await call("readMany", { extra: false }, "organizer");
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBe(4000);
    const over = await call("readMany", { extra: true }, "organizer");
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("LIMIT_EXCEEDED");
    const swallowed = await call("readMany", { extra: true, swallow: true }, "organizer");
    expect(swallowed.body.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("query cannot write", async () => {
    const r = await call("queryWrites", {}, "organizer");
    expect(r.status).toBe(403);
  });

  it("20 parallel registerTicket with capacity=5 → exactly 5 tickets", async () => {
    const stream = await seedRow(h.sql, sys.schema, sys.spec, "stream", { capacity: 5 });
    const type = await seedRow(h.sql, sys.schema, sys.spec, "ticket_type", {
      kind: "standard",
      active: true,
      capacity: 100,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call(
          "registerTicket",
          {
            ticketTypeId: type,
            streamId: stream,
            holderName: `Гость ${i}`,
            holderEmail: `g${i}@example.test`,
          },
          "participant",
          { _consent: consent() },
        ),
      ),
    );
    const rows = await h.sql.unsafe(
      `select count(*)::int as n from "${sys.schema}"."ticket" where stream = $1`,
      [stream],
    );
    expect(rows[0]?.n).toBe(5);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(["STREAM_FULL", "CONFLICT"]).toContain(r.body.error.code);
    }
  }, 60_000);

  it("ctx.db as participant sees only own tickets, ctx.systemDb sees all", async () => {
    const me = await userIdOf(h.sql, sys.schema, "participant");
    await seedRow(h.sql, sys.schema, sys.spec, "ticket", {}, undefined);
    const own = Number(
      (
        await h.sql.unsafe(`select count(*)::int as n from "${sys.schema}"."ticket" where holder_user = $1`, [
          me,
        ])
      )[0]?.n,
    );
    const all = Number((await h.sql.unsafe(`select count(*)::int as n from "${sys.schema}"."ticket"`))[0]?.n);
    expect(all).toBeGreaterThan(own);
    const r = await call("ticketsSeen", {}, "participant");
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ db: own, system: all });
  });

  it("ctx.scheduler writes to _w_jobs in the same transaction (rollback → no job)", async () => {
    const ok = await call("scheduleJob", { fail: false, tag: "keep" }, "organizer");
    expect(ok.status).toBe(200);
    const failed = await call("scheduleJob", { fail: true, tag: "drop" }, "organizer");
    expect(failed.body.error.code).toBe("ROLLED_BACK");
    const jobs = await h.sql.unsafe(`select id, kind, payload, run_at from "${sys.schema}"."_w_jobs"`);
    const tags = jobs.map(
      (j) => (typeof j.payload === "string" ? JSON.parse(j.payload) : j.payload).args?.tag,
    );
    expect(tags).toContain("keep");
    expect(tags).not.toContain("drop");
    const job = jobs.find((j) => j.id === ok.body.result);
    expect(job?.kind).toBe("function");
  });

  it("actions: runQuery in the same executor, connectors go to the outbox, ctx.http to an undeclared host → EGRESS_FORBIDDEN (M2-52)", async () => {
    const before = h.rt.outbox().length;
    const r = await call("nestedAction", {}, "organizer");
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ delivered: false, egress: "EGRESS_FORBIDDEN" });
    expect(r.body.deps).toEqual(expect.arrayContaining(["ticket_type"]));
    const sent = h.rt.outbox().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ integration: "telegram", action: "sendToUser" });
  });
});

describe("without WIZARD_UNSAFE_LOCAL_EXEC", () => {
  it("/api/fn/* → 503 FUNCTIONS_DISABLED", async () => {
    const off = await execHarness(false);
    try {
      const s = await off.fnSystem("fnoff");
      const res = await off.rt.fetch(
        request("POST", s.host, "/api/fn/ticketAvailability", { body: { args: {} } }),
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FUNCTIONS_DISABLED");
    } finally {
      await off.close();
    }
  }, 60_000);
});
