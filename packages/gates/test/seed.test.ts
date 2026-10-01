// backlog M0-11: generateSeed(spec, key) is deterministic and passes DLP (qa.yaml#seed); PC matrix size (qa.yaml#checks).
import { type AppSpec, USERS_ENTITY } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  acceptanceChecks,
  generateConsentChecks,
  generatePermissionChecks,
  generateSeed,
  seedDlp,
  selectG1,
  validateScenario,
} from "../src/index.js";
import { loadBakery } from "./g1-helpers.js";
import { loadForum } from "./helpers.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const specs: [string, AppSpec][] = [
  ["forum", loadForum()],
  ["bakery", loadBakery().spec],
];

describe.each(specs)("generateSeed on %s", (_name, spec) => {
  const seed = generateSeed(spec, "key-1", { now: NOW });

  test("is deterministic for (spec, key) and differs for another key", () => {
    expect(generateSeed(spec, "key-1", { now: NOW })).toEqual(seed);
    expect(JSON.stringify(generateSeed(spec, "key-1", { now: NOW }))).toBe(JSON.stringify(seed));
    expect(generateSeed(spec, "key-2", { now: NOW }).users[0]?.id).not.toBe(seed.users[0]?.id);
  });

  test("passes DLP: only synthetic names, user<N>@example.test, +7 999 000-XX-XX", () => {
    expect(seedDlp(spec, seed)).toEqual([]);
    for (const u of seed.users) {
      expect(u.email).toMatch(/^user\d+@example\.test$/);
      expect(u.phone).toMatch(/^\+7999000\d{4}$/);
    }
  });

  test("2 users per login role, 3–10 rows per entity, refs resolve, enums covered, money × 100", () => {
    for (const r of spec.roles.filter((x) => x.access === "login"))
      expect(seed.users.filter((u) => u.role === r.name)).toHaveLength(2);
    const ids = (entity: string) =>
      new Set(
        entity === USERS_ENTITY ? seed.users.map((u) => u.id) : (seed.rows[entity] ?? []).map((r) => r.id),
      );
    for (const e of spec.entities) {
      const rows = seed.rows[e.name] ?? [];
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.length).toBeLessThanOrEqual(10);
      for (const f of e.fields) {
        const values = rows.map((r) => r[f.name]);
        if (f.type === "ref" && f.required)
          for (const v of values) expect(ids(f.ref?.entity as string).has(v)).toBe(true);
        if (f.type === "enum") expect(new Set(values).size).toBe(Math.min(f.enum?.length ?? 0, rows.length));
        if (f.type === "money") for (const v of values) expect(Number(v) % 100).toBe(0);
        if (f.unique)
          expect(new Set(values.filter((v) => v !== undefined)).size).toBe(
            values.filter((v) => v !== undefined).length,
          );
        if (f.required && f.default === undefined && f.type !== "qr_token")
          for (const v of values) expect(v).not.toBeUndefined();
      }
    }
    // rowFilter owners: users A and B of each such role own rows.
    for (const p of spec.permissions.filter((x) => x.rowFilter)) {
      const [field] = Object.keys(p.rowFilter ?? {});
      const owners = new Set((seed.rows[p.entity] ?? []).map((r) => r[field as string]));
      for (const u of seed.users.filter((x) => x.role === p.role)) expect(owners.has(u.id)).toBe(true);
    }
  });
});

describe.each(specs)("plausible pii=none values on %s (FU-4)", (_name, spec) => {
  const seed = generateSeed(spec, "key-1", { now: NOW });
  const strings = spec.entities.flatMap((e) =>
    e.fields
      .filter((f) => (f.type === "string" || f.type === "text") && (f.pii ?? "none") === "none")
      .map((f) => ({ e, f, values: (seed.rows[e.name] ?? []).map((r) => r[f.name]) })),
  );

  test("no «<label> N» placeholders; titles differ between rows; DLP clean for many keys", () => {
    for (const { f, values } of strings)
      for (const v of values)
        if (typeof v === "string") expect(v).not.toMatch(new RegExp(`^${f.label} \\d+$`));
    for (const { f, values } of strings.filter((x) => /^(name|title)$/.test(x.f.name)))
      expect(new Set(values).size, f.name).toBe(values.length);
    for (let k = 0; k < 25; k++) expect(seedDlp(spec, generateSeed(spec, `k${k}`, { now: NOW }))).toEqual([]);
  });

  test("deterministic per key; another key reorders the vocabulary", () => {
    const names = (key: string) =>
      spec.entities.flatMap((e) =>
        (generateSeed(spec, key, { now: NOW }).rows[e.name] ?? []).map((r) => r.name ?? r.title),
      );
    expect(names("key-1")).toEqual(names("key-1"));
    expect(
      Array.from({ length: 5 }, (_, k) => names(`other-${k}`).join()).some(
        (x) => x !== names("key-1").join(),
      ),
    ).toBe(true);
  });
});

describe("forum seed reads like a real forum", () => {
  const spec = loadForum();
  const seed = generateSeed(spec, "key-1", { now: NOW });
  const rows = (e: string) => seed.rows[e] ?? [];

  test("ticket types by kind: «Стандарт», «VIP», «Партнёрский»; on sale; seats far above seeded tickets", () => {
    const byKind = new Map(rows("ticket_type").map((r) => [r.kind, r]));
    expect(byKind.get("standard")).toMatchObject({ name: "Стандарт", price: 4900, active: true });
    expect(byKind.get("vip")).toMatchObject({ name: "VIP", active: true });
    expect(byKind.get("partner")).toMatchObject({ name: "Партнёрский", price: 0 });
    for (const t of rows("ticket_type"))
      expect(Number(t.capacity)).toBeGreaterThan(
        rows("ticket").filter((x) => x.ticket_type === t.id).length + 10,
      );
    for (const s of rows("stream")) expect(Number(s.capacity)).toBeGreaterThanOrEqual(100);
  });

  test("streams, talks, rooms and companies come from the domain vocabulary", () => {
    expect(rows("stream").map((r) => r.name)).toContain("Ритейл-технологии");
    for (const s of rows("session")) expect(String(s.title).length).toBeGreaterThan(15);
    for (const t of rows("ticket")) if (t.company) expect(t.company).toMatch(/^(ООО|АО) «/);
    for (const q of rows("partner_quota")) expect(Number(q.used)).toBeLessThan(Number(q.total));
  });
});

describe("bakery seed reads like a real bakery", () => {
  const { spec } = loadBakery();
  const seed = generateSeed(spec, "key-1", { now: NOW });
  const rows = (e: string) => seed.rows[e] ?? [];

  test("cakes, options by group, consistent order money", () => {
    for (const p of rows("product")) expect(p.name).toMatch(/Торт|Чизкейк/);
    const opt = new Map(rows("product_option").map((r) => [r.option_group, r]));
    expect(opt.get("weight")?.title).toMatch(/кг$/);
    expect(opt.get("filling")?.weight_kg).toBeUndefined();
    for (const o of rows("cake_order"))
      expect(Number(o.prepay_amount) + Number(o.remaining_amount)).toBe(Number(o.total));
    for (const s of rows("production_slot")) expect(Number(s.capacity)).toBeGreaterThanOrEqual(5);
  });
});

describe("seed DLP rejects values that look like real personal data (SEED_PII)", () => {
  const spec = loadForum();
  test.each([
    ["real-looking name in a PII field", "ticket", "holder_name", "Сергей Кузнецов"],
    ["real email in a PII field", "ticket", "holder_email", "sergey.kuznetsov@mail.ru"],
    ["phone in a free text field", "stream", "description", "звоните +7 912 345-67-89"],
    ["email in a free text field", "session", "title", "пишите на ivanov@yandex.ru"],
  ])("%s", (_n, entity, field, value) => {
    const seed = generateSeed(spec, "k", { now: NOW });
    (seed.rows[entity]?.[0] as Record<string, unknown>)[field] = value;
    expect(seedDlp(spec, seed).map((f) => f.path)).toContain(`/rows/${entity}/0/${field}`);
  });
});

// FU-5: G1 keys are random (sha256(systemKey + specVersion)); ~0.3% of keys drew a provider_payment_id UUID whose
// digit run read as a phone/INN/account, so the seed tripped its own DLP and the whole G1 run ended in error.
describe("the generator never trips its own DLP (FU-5)", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  test.each([
    ["forum", ["seed-dlp-34", "seed-dlp-949", "seed-dlp-1024", "seed-dlp-1111"]],
    ["bakery", ["seed-dlp-949", "seed-dlp-1150", "seed-dlp-1274", "seed-dlp-1475"]],
  ] as const)("%s: keys that used to yield SEED_PII pass; provider ids stay UUIDs", (name, keys) => {
    const spec = name === "forum" ? loadForum() : loadBakery().spec;
    for (const key of keys) {
      const seed = generateSeed(spec, key, { now: NOW });
      expect(seedDlp(spec, seed), key).toEqual([]);
      for (const r of seed.rows.payment ?? []) expect(r.provider_payment_id, key).toMatch(UUID);
    }
  });

  test.each(specs)("%s: 300 more keys are DLP-clean", (_name, spec) => {
    for (let i = 0; i < 300; i++)
      expect(seedDlp(spec, generateSeed(spec, `fu5-${i}`, { now: NOW })), `fu5-${i}`).toEqual([]);
  });
});

describe("check generation", () => {
  const forum = loadForum();

  test("forum PC matrix = |roles| × |entities| × 4 + row/hidden/ro", () => {
    const all = generatePermissionChecks(forum);
    const extra = forum.permissions.reduce(
      (n, p) =>
        n +
        (p.rowFilter && p.ops.some((o) => o !== "create") ? 1 : 0) +
        (p.hiddenFields?.length && p.ops.includes("read") ? 1 : 0) +
        (p.readonlyFields?.length && (p.ops.includes("update") || p.ops.includes("create")) ? 1 : 0),
      0,
    );
    expect(all).toHaveLength(forum.roles.length * forum.entities.length * 4 + extra);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(all.find((c) => c.id === "PC-participant-ticket-row")).toBeDefined();
    expect(all.find((c) => c.id === "PC-volunteer-ticket-hidden")).toBeDefined();
    expect(all.find((c) => c.id === "PC-moderator-speaker_application-ro")).toBeDefined();
  });

  test("G1 selection: AC-referenced + public role + row isolation; consent probes for non-admin creators", () => {
    const sel = selectG1(forum, generatePermissionChecks(forum)).map((c) => c.id);
    expect(sel).toContain("PC-visitor-ticket-read");
    expect(sel.filter((id) => id.startsWith("PC-visitor-"))).toHaveLength(forum.entities.length * 4);
    expect(sel).toContain("PC-participant-ticket-row");
    expect(sel).not.toContain("PC-organizer-stream-read");
    expect(generateConsentChecks(forum).map((c) => c.id)).toEqual(["PC-speaker-speaker_application-consent"]);
  });

  test("AC → SC-<id>: permission 1:1, scenarios carry their DSL and milestone", () => {
    const acs = acceptanceChecks(forum);
    expect(acs.map((c) => c.id)).toEqual([
      "SC-AC1",
      "SC-AC2",
      "SC-AC3",
      "SC-AC4",
      "SC-AC5",
      "SC-AC6",
      "SC-AC7",
    ]);
    expect(acs.find((c) => c.id === "SC-AC7")).toMatchObject({
      kind: "permission",
      role: "visitor",
      probe: { kind: "op", op: "read", expect: "deny" },
    });
    expect(acs.find((c) => c.id === "SC-AC5")?.milestone).toBe("M2");
    for (const c of acs) if (c.scenario) expect(validateScenario(forum, c.scenario)).toEqual([]);
  });
});

describe("scenario DSL static validation", () => {
  const forum = loadForum();
  const sc = (steps: unknown[]) => ({
    id: "SC-AC9",
    title: "т",
    actors: { org: { role: "organizer" } },
    steps: steps as never,
  });
  test.each([
    ["actors as a step", [{ actors: { a: { role: "organizer" } } }], "actors — поле сценария"],
    ["two actions in one step", [{ as: "org", read: { entity: "stream" } }], "ровно одно действие"],
    ["consent on read", [{ read: { entity: "stream" }, consent: true }], "consent допустим"],
    ["undefined variable", [{ read: { entity: "stream", id: "$nope.id" } }], "не определена"],
    [
      "variable used before save",
      [{ read: { entity: "stream", id: "$s.id" } }, { read: { entity: "stream", save: "s" } }],
      "не определена",
    ],
    ["unknown entity", [{ read: { entity: "ghost" } }], "нет в системе"],
    ["unknown field", [{ create: { entity: "stream", data: { nope: 1 } } }], "нет поля"],
    ["unknown function", [{ callFn: { name: "ghost", args: {} } }], "нет в системе"],
    ["unknown actor", [{ as: "ghost" }], "неизвестный участник"],
    ["expect before any action", [{ expect: { status: "ok" } }], "expect без"],
  ])("%s", (_n, steps, message) => {
    expect(validateScenario(forum, sc(steps)).join("\n")).toContain(message);
  });
  test("a valid scenario with $seed, $now and actor ids", () => {
    expect(
      validateScenario(
        forum,
        sc([
          { as: "org" },
          { read: { entity: "stream", id: "$seed.stream[0].id", save: "s" } },
          { expect: { fields: { id: "$s.id" } } },
          { read: { entity: "ticket", where: { holder_user: "$org.id", event_starts_at: "$now+60m" } } },
        ]),
      ),
    ).toEqual([]);
  });
});

describe("G1 catalog", () => {
  test("matches gates.yaml#G1.checks (id, severity, since)", async () => {
    const { G1_CHECKS } = await import("../src/index.js");
    const { loadYaml, REPO_ROOT } = await import("./helpers.js");
    const yaml = (await loadYaml(`${REPO_ROOT}/specs/quality/gates.yaml`)) as {
      G1: { checks: { id: string; severity: string; since?: string }[] };
    };
    expect(G1_CHECKS.map((c) => ({ id: c.id, severity: c.severity, since: c.since }))).toEqual(
      yaml.G1.checks.map((c) => ({ id: c.id, severity: c.severity, since: c.since })),
    );
  });
});
