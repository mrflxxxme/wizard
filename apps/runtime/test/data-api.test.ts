// Data API behaviour beyond the matrix: RLS as the second barrier, isolation of systems, query params, write
// validation, consent, audit, invalidation, RoleSpec, dev-login.
import { quoteIdent, systemRoleName } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complianceInfo, type InvalidationEvent, SYSTEM_SUBJECT } from "../src/index.js";
import { forumSpec, type Harness, harness, login, request, seedRow, seedUser, userIdOf } from "./helpers.js";

const spec = forumSpec();
const A = "alpha--draft.localhost:4100";
const B = "beta--draft.localhost:4100";
const c = complianceInfo(spec);
const consent = { policyVersion: c.policyVersion, textHash: c.consentTextHash };

let h: Harness;
let schemaA = "";
let schemaB = "";
const cookie: Record<string, string> = {};

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
const errCode = async (res: Response) => ((await json(res)).error as { code: string }).code;

beforeAll(async () => {
  h = await harness();
  ({ schema: schemaA } = await h.system("alpha", spec));
  ({ schema: schemaB } = await h.system("beta", spec));
  for (const r of ["organizer", "moderator", "speaker", "participant", "volunteer"])
    cookie[r] = await login(h.rt, A, r);
});

afterAll(async () => {
  await h?.close();
});

describe("RLS (second barrier)", () => {
  async function countAs(
    schema: string,
    role: string,
    userId: string | null,
    table: string,
    dbRole = h.role,
  ): Promise<number> {
    return h.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(dbRole)}`);
      await tx`select set_config('wizard.role', ${role}, true), set_config('wizard.user_id', ${userId ?? ""}, true)`;
      const rows = await tx.unsafe(
        `select count(*)::int as n from ${quoteIdent(schema)}.${quoteIdent(table)}`,
      );
      return Number(rows[0]?.n);
    }) as Promise<number>;
  }

  it("direct SELECT under the runtime role with a role without read → 0 rows", async () => {
    await seedRow(h.sql, schemaA, spec, "ticket");
    expect(await countAs(schemaA, "visitor", null, "ticket")).toBe(0);
    expect(await countAs(schemaA, "speaker", null, "payment")).toBe(0);
    expect(await countAs(schemaA, "organizer", null, "ticket")).toBeGreaterThan(0);
  });

  it("rowFilter in RLS: participant sees only own tickets; system tables only for the system DB role", async () => {
    const me = await userIdOf(h.sql, schemaA, "participant");
    await seedRow(h.sql, schemaA, spec, "ticket", { holder_user: me });
    expect(await countAs(schemaA, "participant", me, "ticket")).toBe(1);
    expect(await countAs(schemaA, "organizer", null, "users")).toBe(0);
    // L3-20: the GUC value '__system' grants nothing; only the role sys_<key>_<env>_system does.
    expect(await countAs(schemaA, "__system", null, "users")).toBe(0);
    expect(await countAs(schemaA, "", null, "users", systemRoleName(schemaA))).toBeGreaterThan(0);
  });

  it("system context of DataAccess runs as sys_<key>_<env>_system, the subject context as the runtime role", async () => {
    const sys = await h.rt.systems.resolve("alpha", "draft");
    const who = await sys?.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
      const sysUser = (await tx.sql`select current_user as u`)[0]?.u;
      await tx.data.count("stream", undefined);
      return sysUser;
    });
    expect(who).toBe(systemRoleName(schemaA));
    const back = await sys?.data.transaction("default", sys.data.publicSubject() as never, async (tx) => {
      await tx.system.count("stream", undefined);
      const inSystem = (await tx.sql`select current_user as u`)[0]?.u;
      await tx.data.count("stream", undefined).catch(() => undefined);
      const inSubject = (await tx.sql`select current_user as u`)[0]?.u;
      return [inSystem, inSubject];
    });
    expect(back).toEqual([systemRoleName(schemaA), h.role]);
  });

  it("system role of one system cannot read another system's schema", async () => {
    const err = await h.sql
      .begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(systemRoleName(schemaA))}`);
        return tx.unsafe(`select count(*) from ${quoteIdent(schemaB)}."users"`);
      })
      .then(
        () => null,
        (e: { code?: string }) => e.code,
      );
    expect(err).toBe("42501");
  });

  it("the runtime connection is not a superuser inside transactions (set_config('role'))", async () => {
    const sys = await h.rt.systems.resolve("alpha", "draft");
    const who = await sys?.data.transaction("default", sys.data.publicSubject() as never, async (tx) => {
      const r = await tx.sql`select current_user as u, current_setting('wizard.role') as role`;
      return r[0];
    });
    expect(who).toEqual({ u: h.role, role: "visitor" });
  });
});

describe("two systems on different hosts", () => {
  it("do not see each other's data and do not accept each other's cookies", async () => {
    const created = await h.rt.fetch(
      request("POST", A, "/api/data/stream", {
        cookie: cookie.organizer,
        body: { name: "Только альфа", capacity: 10 },
      }),
    );
    expect(created.status).toBe(201);
    const { item } = (await json(created)) as { item: { id: string } };
    const bCookie = await login(h.rt, B, "organizer");
    const list = (await json(
      await h.rt.fetch(request("GET", B, "/api/data/stream", { cookie: bCookie })),
    )) as {
      items: { id: string }[];
    };
    expect(list.items.some((i) => i.id === item.id)).toBe(false);
    expect(
      (await h.rt.fetch(request("GET", B, `/api/data/stream/${item.id}`, { cookie: bCookie }))).status,
    ).toBe(404);
    // Alpha's cookie on beta is an unknown session → public role (visitor), not organizer.
    expect((await h.rt.fetch(request("GET", B, "/api/auth/me", { cookie: cookie.organizer }))).status).toBe(
      401,
    );
    const del = await h.rt.fetch(
      request("DELETE", B, `/api/data/stream/${item.id}`, { cookie: cookie.organizer }),
    );
    expect(del.status).toBe(403);
    const rows = await h.sql.unsafe(
      `select count(*)::int as n from ${quoteIdent(schemaB)}."stream" where id = $1`,
      [item.id],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("list query params", () => {
  let key = "";
  beforeAll(async () => {
    key = `cap${Date.now()}`;
    for (const cap of [5, 15, 25, 35]) {
      await seedRow(h.sql, schemaA, spec, "stream", { name: `${key}-${cap}`, capacity: cap });
    }
  });
  const get = (qs: string, who = "organizer") =>
    h.rt.fetch(request("GET", A, `/api/data/stream?${qs}`, { cookie: cookie[who] }));

  it("filters, sorts and paginates", async () => {
    const res = await get(
      `filter[name][contains]=${key}&filter[capacity][gte]=15&sort=-capacity&limit=2&page=1`,
    );
    expect(res.status).toBe(200);
    const body = (await json(res)) as { items: { capacity: number }[]; total: number; hasMore: boolean };
    expect(body.items.map((i) => i.capacity)).toEqual([35, 25]);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(true);
    const p2 = (await json(
      await get(`filter[name][contains]=${key}&filter[capacity][gte]=15&sort=-capacity&limit=2&page=2`),
    )) as {
      items: { capacity: number }[];
      hasMore: boolean;
    };
    expect(p2.items.map((i) => i.capacity)).toEqual([15]);
    expect(p2.hasMore).toBe(false);
    const inList = (await json(
      await get(`filter[name][contains]=${key}&filter[capacity][in]=5,35&sort=capacity`),
    )) as {
      items: { capacity: number }[];
    };
    expect(inList.items.map((i) => i.capacity)).toEqual([5, 35]);
    const isNull = (await json(await get(`filter[name][contains]=${key}&filter[description]=null`))) as {
      total: number;
    };
    expect(isNull.total).toBe(0);
  });

  it("contains escapes LIKE wildcards", async () => {
    const body = (await json(await get("filter[name][contains]=%25"))) as { total: number };
    expect(body.total).toBe(0);
  });

  it("rejects bad params with 422", async () => {
    expect((await get("limit=101")).status).toBe(422);
    expect((await get("limit=0")).status).toBe(422);
    expect((await get("page=0")).status).toBe(422);
    expect((await get("sort=a,b,c,d")).status).toBe(422);
    expect((await get("filter[capacity][gte]=abc")).status).toBe(422);
    expect((await get("filter[capacity][regex]=1")).status).toBe(422);
    const unknown = await get("filter[nope]=1");
    expect(unknown.status).toBe(422);
    expect(await errCode(unknown)).toBe("UNKNOWN_FIELD");
  });

  it("hidden fields: absent from docs, filter/sort → 422 FIELD_HIDDEN", async () => {
    await seedRow(h.sql, schemaA, spec, "ticket");
    const res = await h.rt.fetch(request("GET", A, "/api/data/ticket", { cookie: cookie.volunteer }));
    const body = (await json(res)) as { items: Record<string, unknown>[] };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      for (const f of ["holder_name", "holder_email", "holder_phone", "qr_token", "amount"])
        expect(item).not.toHaveProperty(f);
      expect(item).toHaveProperty("status");
      expect(item).toHaveProperty("created_at");
    }
    const f = await h.rt.fetch(
      request("GET", A, "/api/data/ticket?filter[holder_name]=x", { cookie: cookie.volunteer }),
    );
    expect(f.status).toBe(422);
    expect(await errCode(f)).toBe("FIELD_HIDDEN");
    const s = await h.rt.fetch(
      request("GET", A, "/api/data/ticket?sort=holder_name", { cookie: cookie.volunteer }),
    );
    expect(await errCode(s)).toBe("FIELD_HIDDEN");
  });

  it("doc shape: money/int as numbers, datetime ISO UTC", async () => {
    const id = await seedRow(h.sql, schemaA, spec, "ticket", {
      amount: 1500.5,
      event_starts_at: "2026-10-01T13:00:00+03:00",
    });
    const { item } = (await json(
      await h.rt.fetch(request("GET", A, `/api/data/ticket/${id}`, { cookie: cookie.organizer })),
    )) as {
      item: Record<string, unknown>;
    };
    expect(item.amount).toBe(1500.5);
    expect(item.event_starts_at).toBe("2026-10-01T10:00:00.000Z");
    expect(typeof item.created_at).toBe("string");
    expect(item.updated_at).toBeNull();
  });
});

describe("search q (V3-18)", () => {
  let key = "";
  let mine = "";
  beforeAll(async () => {
    key = `srch${Date.now()}`;
    mine = await seedRow(h.sql, schemaA, spec, "ticket", {
      holder_name: `Анна ${key}`,
      holder_phone: "+79161234567",
      company: "ООО Ромашка",
    });
    await seedRow(h.sql, schemaA, spec, "ticket", {
      holder_name: `Борис ${key}`,
      holder_phone: "+79037654321",
    });
    for (const cap of [7, 70, 700]) await seedRow(h.sql, schemaA, spec, "stream", { name: `${key}-${cap}` });
    await h.sql.unsafe(
      `update ${quoteIdent(schemaA)}.${quoteIdent("stream")} set capacity = (split_part(name, '-', 2))::int where name like $1`,
      [`${key}-%`],
    );
  });
  const get = (path: string, who = "organizer") =>
    h.rt.fetch(request("GET", A, path, { cookie: cookie[who] }));
  const ids = async (res: Response) => ((await json(res)).items as { id: string }[]).map((i) => i.id);

  it("matches any readable text field, a phone by its digits in any notation", async () => {
    expect(await ids(await get(`/api/data/ticket?q=${encodeURIComponent(`анна ${key}`)}`))).toEqual([mine]);
    expect(await ids(await get(`/api/data/ticket?q=${encodeURIComponent("8 (916) 123-45-67")}`))).toEqual([
      mine,
    ]);
    expect(await ids(await get(`/api/data/ticket?q=${encodeURIComponent("ромашк")}`))).toContain(mine);
    const both = await json(await get(`/api/data/ticket?q=${key}`));
    expect(both.total).toBe(2);
  });

  it("an int field by equality («№70» is not 7 or 700), together with filters", async () => {
    const body = (await json(
      await get(`/api/data/stream?q=${encodeURIComponent("№70")}&filter[name][contains]=${key}`),
    )) as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual([`${key}-70`]);
  });

  it("hidden fields never match: a volunteer cannot find a ticket by the holder's phone or name", async () => {
    expect(
      await ids(await get(`/api/data/ticket?q=${encodeURIComponent("+7 916 123 45 67")}`, "volunteer")),
    ).toEqual([]);
    expect(
      await ids(await get(`/api/data/ticket?q=${encodeURIComponent(`Анна ${key}`)}`, "volunteer")),
    ).toEqual([]);
  });

  it("LIKE wildcards are escaped; q longer than 100 → 422", async () => {
    expect((await json(await get("/api/data/ticket?q=%25%25"))).total).toBe(0);
    expect((await get(`/api/data/ticket?q=${"я".repeat(101)}`)).status).toBe(422);
  });
});

describe("allowedValues (V3-18)", () => {
  const G = "gamma--draft.localhost:4100";
  let schemaG = "";
  let moderator = "";
  beforeAll(async () => {
    const limited = structuredClone(spec);
    for (const p of limited.permissions)
      if (p.role === "moderator" && p.entity === "speaker_application")
        p.allowedValues = { status: ["rejected"] };
    ({ schema: schemaG } = await h.system("gamma", limited));
    moderator = await login(h.rt, G, "moderator");
  });

  it("a value outside the list → 422 FIELD_READONLY (VALUE_NOT_ALLOWED); a listed one passes", async () => {
    const id = await seedRow(h.sql, schemaG, spec, "speaker_application");
    const patch = (body: unknown) =>
      h.rt.fetch(request("PATCH", G, `/api/data/speaker_application/${id}`, { cookie: moderator, body }));
    const denied = await patch({ status: "approved" });
    expect(denied.status).toBe(422);
    const err = (await json(denied)).error as { code: string; details: { fields: { code: string }[] } };
    expect(err.code).toBe("FIELD_READONLY");
    expect(err.details.fields[0]?.code).toBe("VALUE_NOT_ALLOWED");
    expect((await patch({ status: null })).status).toBe(422);
    // The refused update is rolled back.
    const [row] = await h.sql.unsafe(
      `select status from ${quoteIdent(schemaG)}.${quoteIdent("speaker_application")} where id = $1`,
      [id],
    );
    expect(row?.status).toBe("new");
    // A row outside the role's rows stays 404 before any value check (G1 row isolation).
    const foreign = await h.rt.fetch(
      request("PATCH", G, `/api/data/speaker_application/00000000-0000-4000-8000-000000000000`, {
        cookie: moderator,
        body: { status: "approved" },
      }),
    );
    expect(foreign.status).toBe(404);
    const ok = await patch({ status: "rejected" });
    expect(ok.status).toBe(200);
    expect(((await json(ok)).item as { status: string }).status).toBe("rejected");
  });
});

describe("writes", () => {
  const post = (entity: string, body: unknown, who = "organizer") =>
    h.rt.fetch(request("POST", A, `/api/data/${entity}`, { cookie: cookie[who], body }));

  it("rejects unknown, system, readonly, qr_token and hidden fields", async () => {
    expect(await errCode(await post("stream", { name: "x", capacity: 1, nope: 1 }))).toBe("UNKNOWN_FIELD");
    expect(await errCode(await post("stream", { name: "x", capacity: 1, id: "x" }))).toBe("FIELD_READONLY");
    const t = await seedRow(h.sql, schemaA, spec, "ticket");
    const patch = (body: unknown, who = "organizer") =>
      h.rt.fetch(request("PATCH", A, `/api/data/ticket/${t}`, { cookie: cookie[who], body }));
    expect(await errCode(await patch({ amount: 1 }))).toBe("FIELD_READONLY");
    expect(await errCode(await patch({ qr_token: "x" }))).toBe("FIELD_READONLY");
    const sa = await seedRow(h.sql, schemaA, spec, "speaker_application");
    const hidden = await h.rt.fetch(
      request("PATCH", A, `/api/data/speaker_application/${sa}`, {
        cookie: cookie.moderator,
        body: { phone: "+79990000000", _consent: consent },
      }),
    );
    expect(hidden.status).toBe(422);
    expect(await errCode(hidden)).toBe("FIELD_HIDDEN");
  });

  it("validates required, enum, ranges and refs with fields[]", async () => {
    const res = await post("ticket_type", { name: "", kind: "nope", price: 1.234 });
    expect(res.status).toBe(422);
    const body = (await json(res)) as {
      error: { code: string; details: { fields: { field: string }[] }; requestId: string };
    };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    const fields = body.error.details.fields.map((f) => f.field).sort();
    expect(fields).toEqual(expect.arrayContaining(["capacity", "kind", "price"]));
    expect(body.error.requestId).toMatch(/[0-9a-f-]{36}/);
    const ref = await post("session", {
      title: "Доклад",
      stream: "00000000-0000-4000-8000-000000000000",
      starts_at: "2026-10-01T10:00:00Z",
      ends_at: "2026-10-01T11:00:00Z",
    });
    expect(ref.status).toBe(422);
    expect(JSON.stringify(await json(ref))).toContain("REF_NOT_FOUND");
  });

  it("unique violation → 409 CONFLICT with field", async () => {
    const ticket = await seedRow(h.sql, schemaA, spec, "ticket");
    const body = { ticket, scanned_at: "2026-10-01T10:00:00Z", device_id: "gate-1" };
    expect((await post("checkin", body)).status).toBe(201);
    const dup = await post("checkin", body);
    expect(dup.status).toBe(409);
    expect(JSON.stringify(await json(dup))).toContain('"field":"ticket"');
  });

  it("rowFilter on create: forced value, a foreign value → 403", async () => {
    const me = await userIdOf(h.sql, schemaA, "speaker");
    const other = await seedUser(h.sql, schemaA, "speaker");
    const base = {
      full_name: "Иван Петров",
      email: "ivan@example.ru",
      topic: "Тема",
      abstract: "Описание",
      _consent: consent,
    };
    const ok = await post("speaker_application", base, "speaker");
    expect(ok.status).toBe(201);
    expect(((await json(ok)).item as Record<string, unknown>).speaker_user).toBe(me);
    expect((await post("speaker_application", { ...base, speaker_user: other }, "speaker")).status).toBe(403);
  });

  it("consent: pii entity without or with wrong _consent → 422 CONSENT_REQUIRED", async () => {
    const base = { full_name: "Анна", email: "anna@example.ru", topic: "Т", abstract: "А" };
    const none = await post("speaker_application", base, "speaker");
    expect(none.status).toBe(422);
    expect(await errCode(none)).toBe("CONSENT_REQUIRED");
    const wrong = await post(
      "speaker_application",
      { ...base, _consent: { policyVersion: "x", textHash: "y" } },
      "speaker",
    );
    expect(await errCode(wrong)).toBe("CONSENT_REQUIRED");
    const spec = (await json(
      await h.rt.fetch(request("GET", A, "/_wizard/spec", { cookie: cookie.speaker })),
    )) as {
      compliance: { policyVersion: string; consentTextHash: string };
    };
    const good = { policyVersion: spec.compliance.policyVersion, textHash: spec.compliance.consentTextHash };
    const created = await post("speaker_application", { ...base, _consent: good }, "speaker");
    expect(created.status).toBe(201);
    const id = ((await json(created)).item as { id: string }).id;
    const patch = (body: unknown) =>
      h.rt.fetch(
        request("PATCH", A, `/api/data/speaker_application/${id}`, { cookie: cookie.speaker, body }),
      );
    // update without pii fields in the body collects no personal data → no consent needed
    expect((await patch({ topic: "Новая тема" })).status).toBe(200);
    // update that writes a pii field → consent required again
    const piiWrite = await patch({ email: "anna2@example.ru" });
    expect(await errCode(piiWrite)).toBe("CONSENT_REQUIRED");
    expect((await patch({ email: "anna2@example.ru", _consent: good })).status).toBe(200);
  });

  it("writes _w_audit without values and publishes invalidation after commit", async () => {
    const sys = await h.rt.systems.resolve("alpha", "draft");
    const seen: InvalidationEvent[] = [];
    const off = sys?.data.events.subscribe((e) => seen.push(e)) ?? (() => {});
    const res = await post("stream", { name: "Аудит", capacity: 3 });
    const id = ((await json(res)).item as { id: string }).id;
    const patched = await h.rt.fetch(
      request("PATCH", A, `/api/data/stream/${id}`, { cookie: cookie.organizer, body: { capacity: 4 } }),
    );
    expect(((await json(patched)).item as { capacity: number; updated_at: string }).capacity).toBe(4);
    expect(
      (await h.rt.fetch(request("DELETE", A, `/api/data/stream/${id}`, { cookie: cookie.organizer }))).status,
    ).toBe(204);
    off();
    expect(seen.filter((e) => e.id === id).map((e) => e.op)).toEqual(["insert", "update", "delete"]);
    const audit = await h.sql.unsafe(
      `select op, fields, role from ${quoteIdent(schemaA)}."_w_audit" where record_id = $1 order by id`,
      [id],
    );
    expect(audit.map((r) => r.op)).toEqual(["create", "update", "delete"]);
    expect(audit[0]?.fields).toEqual(["name", "capacity"]);
    expect(audit[0]?.role).toBe("organizer");
    expect(JSON.stringify(audit)).not.toContain("Аудит");
  });

  it("failed write rolls back and publishes nothing", async () => {
    const sys = await h.rt.systems.resolve("alpha", "draft");
    const seen: InvalidationEvent[] = [];
    const off = sys?.data.events.subscribe((e) => seen.push(e)) ?? (() => {});
    const ticket = await seedRow(h.sql, schemaA, spec, "ticket");
    const body = { ticket, scanned_at: "2026-10-01T10:00:00Z", device_id: "gate-2" };
    await post("checkin", body);
    seen.length = 0;
    expect((await post("checkin", body)).status).toBe(409);
    off();
    expect(seen).toEqual([]);
  });

  it("body > 1 MiB → 413; invalid JSON → 422", async () => {
    const big = await post("stream", { name: "x".repeat(1024 * 1024 + 10), capacity: 1 });
    expect(big.status).toBe(413);
    const bad = await h.rt.fetch(
      request("POST", A, "/api/data/stream", { cookie: cookie.organizer, body: "{oops" }),
    );
    expect(bad.status).toBe(422);
  });

  it("unknown entity → 404; users is not exposed", async () => {
    expect((await h.rt.fetch(request("GET", A, "/api/data/nope", { cookie: cookie.organizer }))).status).toBe(
      404,
    );
    expect(
      (await h.rt.fetch(request("GET", A, "/api/data/users", { cookie: cookie.organizer }))).status,
    ).toBe(404);
  });
});

describe("auth", () => {
  it("anonymous without a public role → 401", async () => {
    const noPublic = {
      ...spec,
      roles: spec.roles.map((r) =>
        r.access === "public" ? { ...r, access: "login" as const, loginMethods: ["email_otp" as const] } : r,
      ),
    };
    await h.system("private", noPublic);
    const res = await h.rt.fetch(request("GET", "private--draft.localhost:4100", "/api/data/stream"));
    expect(res.status).toBe(401);
    expect(await errCode(res)).toBe("UNAUTHENTICATED");
  });

  it("blocked user → 401; duplicated session cookie → 401", async () => {
    const ck = await login(h.rt, A, "partner");
    const id = await userIdOf(h.sql, schemaA, "partner");
    await h.sql.unsafe(`update ${quoteIdent(schemaA)}."users" set blocked_at = now() where id = $1`, [id]);
    expect((await h.rt.fetch(request("GET", A, "/api/data/stream", { cookie: ck }))).status).toBe(401);
    await h.sql.unsafe(`update ${quoteIdent(schemaA)}."users" set blocked_at = null where id = $1`, [id]);
    expect((await h.rt.fetch(request("GET", A, "/api/data/stream", { cookie: ck }))).status).toBe(200);
    const dup = `${ck}; ${ck}`;
    expect((await h.rt.fetch(request("GET", A, "/api/data/stream", { cookie: dup }))).status).toBe(401);
  });

  it("/api/auth/me and logout", async () => {
    const ck = await login(h.rt, A, "moderator");
    const me = (await json(await h.rt.fetch(request("GET", A, "/api/auth/me", { cookie: ck })))) as {
      user: { role: string; isAdmin: boolean; displayName: string };
    };
    expect(me.user).toMatchObject({ role: "moderator", isAdmin: false, displayName: "dev-moderator" });
    const out = await h.rt.fetch(request("POST", A, "/api/auth/logout", { cookie: ck }));
    expect(out.status).toBe(204);
    expect((await h.rt.fetch(request("GET", A, "/api/auth/me", { cookie: ck }))).status).toBe(401);
  });

  it("dev-login: cookie attributes, next only a local path, unknown role → 404", async () => {
    const res = await h.rt.fetch(request("GET", A, "/_wizard/dev-login?role=speaker&next=/tickets?x=1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/tickets?x=1");
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^wz_sess=[A-Za-z0-9_-]{43}; /);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).not.toContain("Domain");
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", "evil"]) {
      const r = await h.rt.fetch(
        request("GET", A, `/_wizard/dev-login?role=speaker&next=${encodeURIComponent(next)}`),
      );
      expect(r.headers.get("location"), next).toBe("/");
    }
    expect((await h.rt.fetch(request("GET", A, "/_wizard/dev-login?role=visitor"))).status).toBe(404);
    expect((await h.rt.fetch(request("GET", A, "/_wizard/dev-login?role=nope"))).status).toBe(404);
    const out = await h.rt.fetch(request("GET", A, "/_wizard/dev-logout", { cookie: cookie.speaker }));
    expect(out.status).toBe(302);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    cookie.speaker = await login(h.rt, A, "speaker");
  });

  it("dev-login does not exist on prod hosts", async () => {
    await h.system("gamma", spec, "prod");
    const res = await h.rt.fetch(request("GET", "gamma.localhost:4100", "/_wizard/dev-login?role=organizer"));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    const redirect = await h.rt.fetch(request("GET", "gamma--prod.localhost:4100", "/x?y=1"));
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("http://gamma.localhost:4100/x?y=1");
  });
});

describe("/_wizard/spec (RoleSpec)", () => {
  it("projects the spec for the role: no hidden fields, only own permissions and pages", async () => {
    const res = await h.rt.fetch(request("GET", A, "/_wizard/spec", { cookie: cookie.volunteer }));
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      role: string;
      roles: { name: string; access: string }[];
      entities: { name: string; fields: { name: string }[] }[];
      permissions: { role: string; hiddenFields?: unknown }[];
      pages: { roles: string[] }[];
      compliance: { consentTextHash: string; policyVersion: string };
    };
    expect(body.role).toBe("volunteer");
    // One RoleSpec contract with ui-kit (FU-4): role is a name, roles lists every role without permissions.
    expect(body.roles.map((r) => r.name)).toContain("organizer");
    expect(body.roles.find((r) => r.name === "visitor")?.access).toBe("public");
    const ticket = body.entities.find((e) => e.name === "ticket");
    expect(ticket?.fields.map((f) => f.name)).not.toContain("holder_name");
    expect(body.entities.map((e) => e.name)).not.toContain("payment");
    expect(body.permissions.every((p) => p.role === "volunteer" && p.hiddenFields === undefined)).toBe(true);
    expect(body.pages.every((p) => p.roles.includes("volunteer"))).toBe(true);
    expect(body.compliance.consentTextHash).toMatch(/^[0-9a-f]{64}$/);
    const etag = res.headers.get("etag") ?? "";
    const again = await h.rt.fetch(
      request("GET", A, "/_wizard/spec", { cookie: cookie.volunteer, headers: { "if-none-match": etag } }),
    );
    expect(again.status).toBe(304);
    const anon = (await json(await h.rt.fetch(request("GET", A, "/_wizard/spec")))) as { role: string };
    expect(anon.role).toBe("visitor");
  });
});
