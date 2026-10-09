// V3-15 regression of the G2 permission matrix on module systems (CHANGELOG, finding of V3-10): PERM-01/02 failed on
// v2 systems too — (1) a probe row hit the unique slot of bookings (23505): the probe generators start their counter at
// 100 000 (G1) and 200 000 (G2), and a unique datetime on days alone (counter mod 3650) came round to the seed's days;
// (2) «Выдача» answered 409 CONFLICT: every role's create probe pointed the item ref of the unique index (resource,
// open) at the first seed item, and the row of the first role stays. The database runs are in
// packages/modules/test/backend.gates.test.ts; here — the generator and the create body without a database.
import { type AppSpec, type Entity, emptySpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import type { Actor, G1Env } from "../src/g1/env.js";
import { Prober } from "../src/g1/probes.js";
import { ValueGen } from "../src/g1/seed.js";
import type { Seed } from "../src/g1/types.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

const booking: Entity = {
  name: "booking",
  label: "Запись",
  fields: [
    { name: "starts_at", label: "Начало", type: "datetime", required: true },
    { name: "seat", label: "Место", type: "int", default: 1, min: 1, max: 1 },
  ],
  indexes: [{ fields: ["starts_at", "seat"], unique: true }],
} as Entity;

const startsAt = (gen: ValueGen, count: number): string[] => {
  const f = booking.fields[0] as Entity["fields"][number];
  return Array.from({ length: count }, (_, i) => String(gen.value(booking, f, i)));
};

describe("V3-15: a unique datetime of a probe never repeats a seed slot (G2-PERM-02, 23505)", () => {
  test("the seed's values are the same as before (a day per counter value below 3650)", () => {
    const seed = startsAt(new ValueGen(NOW, 1), 50);
    seed.forEach((v, k) => {
      expect(v).toBe(new Date(NOW.getTime() + (k + 2) * DAY_MS).toISOString());
    });
  });

  test.each([
    ["G1", 100_000],
    ["G2", 200_000],
  ])("%s probes (counter from %i): 10 000 values, none a seed value, all different", (_g, start) => {
    const seed = new Set(startsAt(new ValueGen(NOW, 1), 3650));
    const probes = startsAt(new ValueGen(NOW, start), 10_000);
    expect(probes.filter((v) => seed.has(v))).toEqual([]);
    expect(new Set(probes).size).toBe(probes.length);
  });
});

describe("V3-15: create probes of different roles do not share the ref of a unique index («Выдача», 409)", () => {
  const item: Entity = {
    name: "resource",
    label: "Предмет",
    fields: [{ name: "title", label: "Название", type: "string", required: true }],
  } as Entity;
  const issue: Entity = {
    name: "resource_issue",
    label: "Выдача",
    fields: [
      { name: "resource", label: "Предмет", type: "ref", required: true, ref: { entity: "resource" } },
      { name: "open", label: "Открыта", type: "int", default: 1 },
    ],
    indexes: [{ fields: ["resource", "open"], unique: true }],
  } as Entity;
  const spec: AppSpec = {
    ...emptySpec("Библиотека"),
    entities: [item, issue],
    permissions: ["owner", "staff"].flatMap((role) => [
      { role, entity: "resource", ops: ["read"] },
      { role, entity: "resource_issue", ops: ["read", "create"], hiddenFields: ["open"] },
    ]),
  } as AppSpec;
  const seed = { users: [], rows: { resource: [{ id: "seed-item-1", title: "Книга" }] } } as unknown as Seed;

  test("each create body points at a fresh item nobody issued, never the first seed item", async () => {
    const inserted: { entity: string; row: Record<string, unknown> }[] = [];
    const env = {
      spec,
      insertRow: async (entity: string, row: Record<string, unknown>) => {
        inserted.push({ entity, row });
      },
    } as unknown as G1Env;
    const prober = new Prober(env, {
      seed,
      gen: new ValueGen(NOW, 200_000),
      consent: null,
      actors: new Map(),
    });
    const actor = { id: null } as unknown as Actor;
    const owner = await prober.createBody(issue, "owner", actor);
    const staff = await prober.createBody(issue, "staff", actor);
    expect(owner.problem).toBeUndefined();
    expect(staff.problem).toBeUndefined();
    expect(owner.body.resource).not.toBe("seed-item-1");
    expect(staff.body.resource).not.toBe(owner.body.resource);
    expect(inserted.map((x) => x.entity)).toEqual(["resource", "resource"]);
    expect(inserted.map((x) => x.row.id)).toEqual([owner.body.resource, staff.body.resource]);
  });
});
