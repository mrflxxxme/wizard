// backlog M2-04: G2 against a real apps/runtime — full permission matrix (data API and SQL under RLS), row isolation and
// hidden fields incl. public functions, ctx.systemDb ПДн stripped by the runtime (L3-22); dynamic per-check fixtures;
// forum passes G2, bakery fails only on freeSlots without systemDbReason; no app_%_g2_% schema survives.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error — plain ESM module without types
import { validateSchema } from "../../../tools/specs/validate.mjs";
import { type Check, type GateReport, runG2, runGates } from "../src/index.js";
import { type G1Harness, g1Harness, loadBakery } from "./g1-helpers.js";
import { DYNAMIC_IDS, FIXTURES_DIR, materialize, readCases, STATIC_IDS } from "./g2-helpers.js";
import { loadYaml, REPO_ROOT } from "./helpers.js";

const apiSpec = (await loadYaml(join(REPO_ROOT, "specs/platform/api.yaml"))) as {
  components: { schemas: Record<string, unknown> };
};

let h: G1Harness;
beforeAll(async () => {
  h = await g1Harness();
});
afterAll(async () => {
  const rows =
    await h.db`select count(*)::int as n from pg_namespace where nspname like ${`app\\_${h.keyPrefix}\\_%\\_g2\\_%`}`;
  expect(Number(rows[0]?.n)).toBe(0);
  await h.close();
});

const failing = (r: GateReport) =>
  r.checks.filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"));
const show = (c: Check[]) => JSON.stringify(c, null, 1).slice(0, 3000);

describe("G2 on the golden systems", () => {
  test("forum: runGates('G2') with a runtime passes; the matrix checks run; report matches api.yaml GateReport", async () => {
    const r = await runGates("G2", h.ctx({ milestone: "M2" }));
    expect(failing(r), show(failing(r))).toEqual([]);
    expect(r.passed).toBe(true);
    for (const id of DYNAMIC_IDS) expect(r.checks.find((c) => c.id === id)?.status).toBe("pass");
    expect(r.checks.find((c) => c.id === "G2-AF-09")?.status).toBe("warn");
    expect(r.durationMs).toBeLessThan(300_000);
    expect(validateSchema(apiSpec.components.schemas.GateReport, r, apiSpec)).toEqual([]);
  }, 300_000);

  test("bakery: the only blocker is freeSlots reading cake_order via ctx.systemDb for visitors (L3-22)", async () => {
    const b = loadBakery();
    const r = await runG2(h.ctx({ milestone: "M2", spec: b.spec, files: b.files }));
    expect(failing(r).map((c) => `${c.id} ${c.path}`)).toEqual(["G2-PERM-05 /functions/1"]);
    const spec = structuredClone(b.spec);
    Object.assign(spec.functions?.[1] ?? {}, {
      systemDbReason: "Считает загрузку дней, наружу только числа",
    });
    // systemDbReason is not in appspec.schema.json yet (notes M2-04): migrations reject it, so static checks only.
    const ok = await runG2(h.ctx({ milestone: "M2", spec, files: b.files }), { only: STATIC_IDS });
    expect(failing(ok), show(failing(ok))).toEqual([]);
  }, 300_000);

  test("time budget exhausted → remaining checks error, gate not passed", async () => {
    const r = await runG2(h.ctx({ milestone: "M2" }), { timeBudgetMs: 1 });
    expect(r.passed).toBe(false);
    expect(r.checks.some((c) => c.status === "error" && c.message_ru.includes("300"))).toBe(true);
  });
});

describe("per-check fixtures (permission matrix against the runtime)", () => {
  const fx = [...readCases(FIXTURES_DIR)].filter(([k]) => DYNAMIC_IDS.includes(k.split("/")[0] as string));
  for (const [name, c] of fx) {
    test(name, async () => {
      const { ctx, dynamic } = materialize(c, h.db, {
        runtime: h.rt,
        runtimeRole: h.role,
        systemKey: `${h.keyPrefix}_${Math.random().toString(16).slice(2, 8)}`,
      });
      const r = await runG2(ctx, { only: [c.check as string], dynamic });
      const mine = r.checks.filter((x) => x.id === c.check);
      if (c.expect === "pass")
        expect(
          mine.every((x) => x.status === "pass"),
          show(mine),
        ).toBe(true);
      else {
        const hits = mine.filter((x) => x.status === c.expect);
        expect(hits.length, show(mine)).toBeGreaterThan(0);
        if (c.match)
          expect(
            hits.some((x) => `${x.message_ru} ${x.evidence ?? ""}`.includes(c.match as string)),
            show(hits),
          ).toBe(true);
      }
    }, 120_000);
  }
});
