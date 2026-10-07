// B2-26 module factory (grill-6 decision 4, db.yaml#module_candidates, workflows.yaml#module_factory_cron): the weekly
// rating of «Запросы на развитие» and successful custom parts by frequency on a fixture; the founder approves, disables
// and marks a candidate ready in /admin (staff with TOTP only); «Теперь умеем» goes only to clients who agreed to
// letters, once per client and module, and the covered requests become «done». No model is called.
import { randomUUID } from "node:crypto";
import { DEFAULT_REGISTRY, type ModuleRegistry } from "@wizard/agents/planner";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import type { MailMessage } from "../src/auth/mailer.js";
import { totpCode } from "../src/auth/totp.js";
import { json } from "../src/db/index.js";
import {
  candidateKey,
  decideModuleCandidate,
  type FactorySource,
  normalizeWording,
  rankCandidates,
  recomputeModuleCandidates,
  runModuleFactoryCron,
} from "../src/gaps/factory.js";
import { createTestDb, startApi, type TestApi } from "./helpers.js";
import { devLogin, expectContract, MemoryMailer, type Session } from "./session.js";

const NOW = new Date("2026-10-12T06:17:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("rating (pure, fixture)", () => {
  test("wording: word order, endings, stop words and scrub placeholders do not split a group", () => {
    expect(normalizeWording("Хочу онлайн-оплату картой")).toBe(normalizeWording("оплата картой онлайн"));
    expect(candidateKey("payments", "Нужна оплата картой [ТЕЛЕФОН_1]")).toBe(
      candidateKey("payments", "оплату картой"),
    );
    // A custom part «title: description» groups by its title.
    expect(candidateKey("other", "Калькулятор стоимости: считает цену ремонта по площади")).toBe(
      candidateKey("other", "Калькулятор стоимости"),
    );
    expect(candidateKey("payments", "Оплата картой")).not.toBe(candidateKey("messaging", "Оплата картой"));
    expect(candidateKey("other", "и в на")).toBe("other");
  });

  test("frequency of the week first, then all time; custom parts once per system; systems and clients", () => {
    const src = (
      kind: FactorySource["kind"],
      category: FactorySource["category"],
      quote: string,
      systemId: string,
      orgId: string,
      at: Date,
    ): FactorySource => ({
      kind,
      category,
      quote,
      systemId,
      orgId,
      at,
      ...(kind === "request" ? { requestId: randomUUID() } : {}),
    });
    const groups = rankCandidates(
      [
        src("request", "payments", "Приём оплаты картой на сайте", "s1", "o1", daysAgo(1)),
        src("request", "payments", "Оплата картой", "s2", "o1", daysAgo(2)),
        src("request", "payments", "Оплата картой", "s3", "o2", daysAgo(3)),
        src("request", "payments", "оплату картой", "s3", "o2", daysAgo(20)),
        src("custom", "other", "Калькулятор стоимости: по площади", "s4", "o3", daysAgo(1)),
        src("custom", "other", "Калькулятор стоимости: по площади", "s4", "o3", daysAgo(2)),
        src("custom", "other", "Калькулятор стоимости", "s5", "o4", daysAgo(4)),
        src("request", "other", "Калькулятор стоимости: не прошло проверку", "s6", "o5", daysAgo(5)),
        src("request", "messaging", "SMS-напоминания", "s7", "o6", daysAgo(8)),
        src("request", "messaging", "СМС напоминания", "s1", "o1", daysAgo(9)),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.rank, g.category, g.title])).toEqual([
      [1, "payments", "Оплата картой"],
      [2, "other", "Калькулятор стоимости"],
      [3, "messaging", "SMS-напоминания"],
      [4, "messaging", "СМС напоминания"],
    ]);
    expect(groups[0]).toMatchObject({
      weekRequests: 3,
      totalRequests: 4,
      weekCustom: 0,
      systems: 3,
      clients: 2,
    });
    expect(groups[0]?.requestIds).toHaveLength(4);
    // The repeated custom part of system s4 counts once.
    expect(groups[1]).toMatchObject({
      weekRequests: 1,
      weekCustom: 2,
      totalCustom: 2,
      systems: 3,
      clients: 3,
    });
    expect(groups[1]?.examples.map((e) => e.source)).toEqual(["custom", "custom", "request"]);
    expect(groups[2]).toMatchObject({ weekRequests: 0, totalRequests: 1 });
  });
});

class FlakyMailer extends MemoryMailer {
  readonly failOnce = new Set<string>();
  override async send(m: MailMessage): Promise<void> {
    if (this.failOnce.delete(m.to)) throw new Error("smtp down");
    return super.send(m);
  }
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const mailer = new FlakyMailer();
let staff: Session;
const clients: Record<string, { s: Session; orgId: string; systems: string[] }> = {};

async function addSystem(orgId: string, userId: string, name: string): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: orgId,
      slug: `f-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addRequest(
  who: string,
  sys: number,
  category: string,
  quote: string,
  at: Date,
): Promise<string> {
  const c = clients[who];
  if (!c) throw new Error(who);
  const row = await api.deps.db
    .insertInto("platform.development_requests")
    .values({
      org_id: c.orgId,
      system_id: c.systems[sys] ?? null,
      user_id: c.s.userId,
      category,
      quote,
      offered: "Заявка с оплатой по счёту",
      created_at: at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  tdb = await createTestDb("factory");
  api = await startApi(tdb.url, { mailer, now: () => NOW, moduleFactoryMs: 0 });
  for (const name of ["anna", "boris", "viktor", "galina"]) {
    const s = await devLogin(api, `${name}@factory.example`);
    const orgId = (await s.req("GET", "/me")).body.memberships[0].orgId as string;
    clients[name] = {
      s,
      orgId,
      systems: [
        await addSystem(orgId, s.userId, `Студия ${name}`),
        await addSystem(orgId, s.userId, `Школа ${name}`),
      ],
    };
  }
  staff = await devLogin(api, "founder-factory@example.test");
  await setStaff(api.deps.db, "founder-factory@example.test", true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });

  // Fixture: «абонементы» asked by anna (consent), boris (no consent) and viktor twice (consent, two systems).
  await addRequest("anna", 0, "subscriptions", "Хочу продавать абонементы на занятия", daysAgo(1));
  await addRequest("boris", 0, "subscriptions", "Продавать абонементы на занятия", daysAgo(2));
  await addRequest("viktor", 0, "subscriptions", "абонементы на занятия [ТЕЛЕФОН_1]", daysAgo(3));
  await addRequest("viktor", 1, "subscriptions", "Абонементы на занятия", daysAgo(10));
  await addRequest("galina", 0, "messaging", "SMS-рассылка клиентам", daysAgo(2));
  await addRequest("galina", 1, "payments", "Оплата картой на сайте", daysAgo(30));
  // A successful custom part of a plan build (the custom stage checkpoint, B2-23) in galina's system.
  await api.deps.db
    .insertInto("platform.system_plans")
    .values({
      system_id: clients.galina?.systems[0] as string,
      revision: 1,
      status: "approved",
      source: "planner",
      plan: json({
        custom: [{ id: "calc", title: "Калькулятор стоимости", description: "Считает цену по площади" }],
      }),
      approved_at: daysAgo(1),
      checkpoints: json({
        custom: {
          stage: "custom",
          planHash: "x",
          data: { items: [{ id: "calc", kind: "screen", title: "Калькулятор стоимости", status: "done" }] },
          costMilli: 0,
          durationMs: 1,
          runId: randomUUID(),
        },
      }),
    })
    .execute();
  for (const who of ["anna", "viktor"])
    expect((await clients[who]?.s.req("PUT", "/me/updates-consent", { body: { on: true } }))?.status).toBe(
      200,
    );
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const updates = () => mailer.sent.filter((m) => m.kind === "updates");

describe("client consent to «Теперь умеем» letters", () => {
  test("off by default; the client switches it", async () => {
    const b = clients.boris?.s as Session;
    const off = await b.req("GET", "/me/updates-consent");
    expectContract("getUpdatesConsent", off);
    expect(off.body).toEqual({ on: false, since: null });
    const a = await clients.anna?.s.req("GET", "/me/updates-consent");
    expect(a?.body).toMatchObject({ on: true, since: NOW.toISOString() });
    const bad = await b.req("PUT", "/me/updates-consent", { body: { on: "yes" } });
    expect(bad.status).toBe(400);
  });
});

describe("/admin «Кандидаты в модули»", () => {
  let subs = "";
  let sms = "";

  test("staff only: non-staff 404", async () => {
    expect((await clients.anna?.s.req("GET", "/admin/module-candidates"))?.status).toBe(404);
    expect((await clients.anna?.s.req("POST", "/admin/module-candidates/recompute"))?.status).toBe(404);
  });

  test("recompute: the weekly rating by frequency with systems, clients and quotes", async () => {
    const empty = await staff.req("GET", "/admin/module-candidates");
    expect(empty.body).toMatchObject({ computedAt: null, items: [] });
    const r = await staff.req("POST", "/admin/module-candidates/recompute");
    expect(r.status, r.text).toBe(200);
    expectContract("adminRecomputeModuleCandidates", r);
    expect(r.body).toMatchObject({ candidates: 4, sent: 0 });
    const list = await staff.req("GET", "/admin/module-candidates");
    expect(list.status, list.text).toBe(200);
    expectContract("adminModuleCandidates", list);
    expect(list.body.computedAt).toBe(NOW.toISOString());
    const rows = list.body.items as {
      id: string;
      rank: number;
      category: string;
      title: string;
      weekRequests: number;
      totalRequests: number;
      weekCustom: number;
      systems: number;
      clients: number;
      examples: { quote: string }[];
      suggested: { id: string } | null;
    }[];
    expect(rows.map((x) => [x.rank, x.category])).toEqual([
      [1, "subscriptions"],
      [2, "messaging"],
      [3, "other"],
      [4, "payments"],
    ]);
    expect(rows[0]).toMatchObject({ weekRequests: 3, totalRequests: 4, systems: 4, clients: 3 });
    expect(rows[0]?.title).toBe("Абонементы на занятия");
    expect(rows[2]).toMatchObject({ title: "Калькулятор стоимости", weekCustom: 1, systems: 1, clients: 1 });
    expect(JSON.stringify(rows)).not.toContain("@factory.example");
    // Linked to the catalog by wording: «абонементы» is close to «Абонементы и пакеты».
    expect(rows[0]?.suggested?.id).toBe("packages");
    expect(list.body.modules.find((m: { id: string }) => m.id === "packages")).toMatchObject({
      status: "ready",
      available: true,
    });
    subs = rows[0]?.id as string;
    sms = rows[1]?.id as string;
    const linked = await api.deps.db
      .selectFrom("platform.development_requests")
      .select(["candidate_id", "status"])
      .where("category", "=", "subscriptions")
      .execute();
    expect(linked.every((x) => x.candidate_id === subs && x.status === "open")).toBe(true);
    // A second pass is idempotent: the same candidates and ranks.
    await staff.req("POST", "/admin/module-candidates/recompute");
    const again = await staff.req("GET", "/admin/module-candidates");
    expect(again.body.items.map((x: { id: string; rank: number }) => [x.id, x.rank])).toEqual(
      rows.map((x) => [x.id, x.rank]),
    );
  });

  test("card: quotes without addresses, the linked requests and their systems", async () => {
    const card = await staff.req("GET", `/admin/module-candidates/${subs}`);
    expect(card.status, card.text).toBe(200);
    expectContract("adminModuleCandidate", card);
    expect(card.body.requests).toHaveLength(4);
    expect(card.body.notified).toBe(0);
    expect(card.body.candidate.examples.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(card.body)).not.toContain("@factory.example");
    expect((await staff.req("GET", `/admin/module-candidates/${randomUUID()}`)).status).toBe(404);
    expect((await staff.req("GET", "/admin/module-candidates/nope")).status).toBe(404);
  });

  test("approve and disable; the open rating hides disabled; every decision is journaled", async () => {
    const ok = await staff.req("POST", `/admin/module-candidates/${subs}/decision`, {
      body: { action: "approve", note: "Сделать модуль абонементов" },
    });
    expect(ok.status, ok.text).toBe(200);
    expectContract("adminDecideModuleCandidate", ok);
    expect(ok.body).toMatchObject({
      candidate: { status: "approved", note: "Сделать модуль абонементов" },
      announced: null,
    });
    const off = await staff.req("POST", `/admin/module-candidates/${sms}/decision`, {
      body: { action: "disable" },
    });
    expect(off.body.candidate.status).toBe("disabled");
    const open = await staff.req("GET", "/admin/module-candidates");
    expect(open.body.items.map((x: { id: string }) => x.id)).not.toContain(sms);
    const disabled = await staff.req("GET", "/admin/module-candidates?status=disabled");
    expect(disabled.body.items.map((x: { id: string }) => x.id)).toEqual([sms]);
    // The founder's status survives a recompute.
    await staff.req("POST", "/admin/module-candidates/recompute");
    const kept = await staff.req("GET", "/admin/module-candidates?status=all");
    expect(kept.body.items.find((x: { id: string }) => x.id === subs).status).toBe("approved");
    const audit = await api.deps.db
      .selectFrom("platform.staff_audit_log")
      .select(["action", "target"])
      .where("target", "like", "module_candidate:%")
      .orderBy("id")
      .execute();
    expect(audit).toEqual([
      { action: "module_candidate_approve", target: `module_candidate:${subs}` },
      { action: "module_candidate_disable", target: `module_candidate:${sms}` },
    ]);
    expect(
      (await staff.req("POST", `/admin/module-candidates/${subs}/decision`, { body: { action: "close" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await clients.anna?.s.req("POST", `/admin/module-candidates/${subs}/decision`, {
          body: { action: "disable" },
        })
      )?.status,
    ).toBe(404);
  });

  test("«модуль готов»: needs a catalog module; requests done; one letter to each client who agreed", async () => {
    const none = await staff.req("POST", `/admin/module-candidates/${subs}/decision`, {
      body: { action: "ready" },
    });
    expect(none.status).toBe(400);
    expect(none.body.message_ru).toContain("модуль каталога");
    const unknown = await staff.req("POST", `/admin/module-candidates/${subs}/decision`, {
      body: { action: "ready", moduleId: "teleport" },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message_ru).toContain("нет модуля");
    // The first letter to viktor fails: his mark is given back, the next pass sends it.
    mailer.failOnce.add("viktor@factory.example");
    const ready = await staff.req("POST", `/admin/module-candidates/${subs}/decision`, {
      body: { action: "ready", moduleId: "packages" },
    });
    expect(ready.status, ready.text).toBe(200);
    expectContract("adminDecideModuleCandidate", ready);
    expect(ready.body.candidate).toMatchObject({
      status: "ready",
      moduleId: "packages",
      moduleName: "Абонементы и пакеты",
    });
    expect(ready.body.announced).toEqual({ done: 4, sent: 1, noConsent: 1, failed: 1 });
    expect(updates().map((m) => m.to)).toEqual(["anna@factory.example"]);
    const letter = updates()[0] as MailMessage;
    expect(letter.subject).toBe("Теперь умеем: Абонементы и пакеты");
    expect(letter.text).toContain("Вы просили: «Хочу продавать абонементы на занятия»");
    expect(letter.text).toContain(`http://localhost:5173/s/${clients.anna?.systems[0]}`);
    expect(letter.text).toContain("http://localhost:5173/billing");

    // Weekly pass: viktor gets his letter once (his latest request's system), boris still nothing.
    await runModuleFactoryCron({ db: api.deps.db, mailer, platformOrigin: "http://localhost:5173" }, NOW);
    expect(updates().map((m) => m.to)).toEqual(["anna@factory.example", "viktor@factory.example"]);
    expect(updates()[1]?.text).toContain(`/s/${clients.viktor?.systems[0]}`);
    await staff.req("POST", "/admin/module-candidates/recompute");
    expect(updates()).toHaveLength(2);

    const reqs = await staff.req("GET", "/admin/development-requests?category=subscriptions");
    expectContract("adminDevelopmentRequests", reqs);
    expect(reqs.body.items.map((x: { status: string }) => x.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(reqs.body.items[0].doneAt).toBe(NOW.toISOString());
    const card = await staff.req("GET", `/admin/module-candidates/${subs}`);
    expect(card.body.notified).toBe(2);
    // Ready is final.
    const again = await staff.req("POST", `/admin/module-candidates/${subs}/decision`, {
      body: { action: "disable" },
    });
    expect(again.status).toBe(400);
    const listReady = await staff.req("GET", "/admin/module-candidates?status=ready");
    expect(listReady.body.items.map((x: { id: string }) => x.id)).toEqual([subs]);
  });

  test("a client who agrees later and asks again gets the letter once; the new request is done", async () => {
    await clients.boris?.s.req("PUT", "/me/updates-consent", { body: { on: true } });
    await addRequest("boris", 1, "subscriptions", "Продавать абонементы на занятия", daysAgo(0));
    await staff.req("POST", "/admin/module-candidates/recompute");
    expect(updates().map((m) => m.to)).toEqual([
      "anna@factory.example",
      "viktor@factory.example",
      "boris@factory.example",
    ]);
    await recomputeModuleCandidates(
      { db: api.deps.db, mailer, platformOrigin: "http://localhost:5173" },
      NOW,
    );
    expect(updates()).toHaveLength(3);
    const open = await api.deps.db
      .selectFrom("platform.development_requests")
      .select("id")
      .where("category", "=", "subscriptions")
      .where("status", "=", "open")
      .execute();
    expect(open).toEqual([]);
    // A client who switched letters off is not written to about the next module.
    await clients.anna?.s.req("PUT", "/me/updates-consent", { body: { on: false } });
    expect((await clients.anna?.s.req("GET", "/me/updates-consent"))?.body).toEqual({
      on: false,
      since: null,
    });
  });

  test("a module that does not compile yet cannot be marked ready (draft in the catalog)", async () => {
    const registry: ModuleRegistry = {
      ...DEFAULT_REGISTRY,
      modules: [
        ...DEFAULT_REGISTRY.modules,
        {
          manifest: {
            ...(DEFAULT_REGISTRY.modules[0]?.manifest as ModuleRegistry["modules"][number]["manifest"]),
            id: "online_pay",
            name: "Онлайн-оплата",
            summary: "Оплата картой и СБП на сайте",
            status: "draft",
          },
        },
      ],
    };
    const pay = await api.deps.db
      .selectFrom("platform.module_candidates")
      .select("id")
      .where("category", "=", "payments")
      .executeTakeFirstOrThrow();
    const d = { db: api.deps.db, mailer, platformOrigin: "http://localhost:5173", registry };
    await expect(
      decideModuleCandidate(
        d,
        { id: pay.id, action: "ready", moduleId: "online_pay", by: staff.userId },
        NOW,
      ),
    ).rejects.toThrow(/ещё не готов/);
    // Approving it «в работу» with the future module is fine.
    const res = await decideModuleCandidate(
      d,
      { id: pay.id, action: "approve", moduleId: "online_pay", by: staff.userId },
      NOW,
    );
    expect(res?.candidate).toMatchObject({
      status: "approved",
      moduleId: "online_pay",
      moduleName: "Онлайн-оплата",
    });
  });

  test("the in-process timer recomputes only a week-old rating", async () => {
    const d = { db: api.deps.db, mailer, platformOrigin: "http://localhost:5173" };
    expect(await runModuleFactoryCron(d, NOW, { ifStale: true })).toBeNull();
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect((await runModuleFactoryCron(d, later, { ifStale: true }))?.computedAt).toEqual(later);
  });
});
