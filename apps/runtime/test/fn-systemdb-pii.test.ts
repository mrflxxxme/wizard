// sdk.md §2.3 (L3-22, backlog M2-04): ПДн read through ctx.systemDb that the caller's role cannot see are cut out of
// the /api/fn result — whole documents, re-mapped objects and strings built from them; visible ones stay.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiiTaint } from "../src/exec/pii-strip.js";
import { type ExecHarness, type ExecSystem, type ExtraFunction, execHarness } from "./exec-helpers.js";
import { forumSpec, login, request, seedRow, userIdOf } from "./helpers.js";

const EXTRA: ExtraFunction[] = [
  {
    name: "allTickets",
    kind: "query",
    roles: ["visitor", "participant", "volunteer", "organizer"],
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async (ctx) => {
  const docs = await ctx.systemDb.ticket.list({ limit: 100 });
  return {
    docs,
    mapped: docs.map((t) => ({ id: t.id, who: t.holder_name, contact: [t.holder_email, t.holder_phone], status: t.status })),
    line: docs.map((t) => "Билет " + t.holder_name + " · " + t.status).join("; "),
    count: await ctx.systemDb.ticket.count({}),
  };
}});`,
  },
];

let h: ExecHarness;
let sys: ExecSystem;
const cookie: Record<string, string> = {};
const mine = {
  holder_name: "Участникова Анна",
  holder_email: "anna.mine@example.ru",
  holder_phone: "+79990001111",
};
const other = {
  holder_name: "Посторонний Борис",
  holder_email: "boris.other@example.ru",
  holder_phone: "+79990002222",
};

async function call(role?: string): Promise<string> {
  const res = await h.rt.fetch(
    request("POST", sys.host, "/api/fn/allTickets", {
      cookie: role ? cookie[role] : undefined,
      body: { args: {} },
    }),
  );
  expect(res.status).toBe(200);
  return res.text();
}

beforeAll(async () => {
  h = await execHarness();
  sys = await h.fnSystem("fnpii", EXTRA);
  for (const r of ["participant", "volunteer", "organizer"]) cookie[r] = await login(h.rt, sys.host, r);
  const me = await userIdOf(h.sql, sys.schema, "participant");
  await seedRow(h.sql, sys.schema, sys.spec, "ticket", { ...mine, holder_user: me, status: "paid" }, me);
  await seedRow(h.sql, sys.schema, sys.spec, "ticket", { ...other, status: "paid" });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const values = (o: Record<string, string>) => Object.values(o);

describe("ctx.systemDb ПДн in /api/fn results", () => {
  it("public role: every holder_* value is gone (docs, re-mapped objects, built strings); the rest stays", async () => {
    const text = await call();
    for (const v of [...values(mine), ...values(other)]) expect(text).not.toContain(v);
    const body = JSON.parse(text).result;
    expect(body.count).toBe(2);
    expect(body.docs).toHaveLength(2);
    expect(body.docs[0]).not.toHaveProperty("holder_phone");
    expect(body.docs[0]).toHaveProperty("status", "paid");
    expect(body.mapped[0].contact).toEqual([null, null]);
    expect(body.line).toContain("Билет");
  });

  it("row-filtered role keeps its own ПДн and loses the others'", async () => {
    const text = await call("participant");
    for (const v of values(mine)) expect(text).toContain(v);
    for (const v of values(other)) expect(text).not.toContain(v);
  });

  it("hiddenFields are stripped too (volunteer reads tickets without holder_*); isAdmin with read sees all", async () => {
    const vol = await call("volunteer");
    for (const v of [...values(mine), ...values(other)]) expect(vol).not.toContain(v);
    const org = await call("organizer");
    for (const v of [...values(mine), ...values(other)]) expect(org).toContain(v);
  });

  it("the system subject (workflows, scheduler) is not filtered", () => {
    const t = new PiiTaint(forumSpec(), { id: null, role: "__system", attrs: {}, isAdmin: false });
    t.observe("ticket", "list", [{ id: "x", ...other }]);
    expect(t.active).toBe(false);
    expect(t.strip({ n: other.holder_phone })).toEqual({ n: other.holder_phone });
  });
});
