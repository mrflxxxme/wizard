// M2-72, G0-MIG-01 (gates.yaml#G0): in prod a revision that removes or narrows data blocks until the owner confirmed
// it (GateContext.destructiveConfirmed); with the confirmation the plan and the shadow apply (archive instead of DROP)
// pass. Index-only drops change no data and need no confirmation.
import { type AppSpec, applyOps, type Op } from "@wizard/appspec";
import { afterAll, describe, expect, test } from "vitest";
import { checkMigrationPlan, checkShadowApply } from "../src/g0/migrations.js";
import { connect, loadForum, uniqueKey } from "./helpers.js";

const db = connect();
afterAll(() => db.end());

function edit(spec: AppSpec, ops: unknown[]): AppSpec {
  const r = applyOps(spec, ops as Op[], 1, { currentVersion: 1, env: "draft" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const prev = loadForum();
const removed = edit(prev, [{ op: "remove_field", entity: "stream", name: "description" }]);

describe("G0-MIG-01 destructive changes in prod", () => {
  test("without confirmation: one blocker DESTRUCTIVE_IN_PROD in plain words", () => {
    const f = checkMigrationPlan(prev, removed, "prod");
    expect(f).toHaveLength(1);
    expect(f[0]?.evidence).toMatch(/^DESTRUCTIVE_IN_PROD: drop_column stream description/);
    expect(f[0]?.message_ru).toMatch(/ждёт подтверждения владельца/);
  });

  test("with the owner's confirmation the plan passes; draft never needs one", () => {
    expect(checkMigrationPlan(prev, removed, "prod", { destructiveConfirmed: true })).toEqual([]);
    expect(checkMigrationPlan(prev, removed, "draft")).toEqual([]);
  });

  test("an index-only drop needs no confirmation", () => {
    const stream = prev.entities.find((e) => e.name === "stream");
    const withIndex = edit(prev, [
      { op: "update_entity", name: "stream", indexes: [...(stream?.indexes ?? []), { fields: ["name"] }] },
    ]);
    expect(checkMigrationPlan(withIndex, prev, "prod")).toEqual([]);
  });

  test("G0-MIG-02: the confirmed plan applies to the shadow schema with the archive", async () => {
    const key = uniqueKey("g0d");
    expect(await checkShadowApply(db, key, prev, removed, "prod", { destructiveConfirmed: true })).toEqual(
      [],
    );
    const [left] = await db`select count(*)::int as n from pg_namespace where nspname like ${`app_${key}%`}`;
    expect(left?.n).toBe(0); // rolled back, archive included
  });
});
