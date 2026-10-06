// A 422 VALIDATION_FAILED in a G1 scenario names the fields and rules that failed (names and codes only, no values):
// the builder and QA see what to fix instead of a bare «HTTP 422» (D67 eval 06.10.2026).
import type { AppSpec } from "@wizard/appspec";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { G1Env } from "../src/g1/env.js";
import { runScenario } from "../src/g1/scenario.js";
import type { Scenario } from "../src/g1/types.js";
import type { RuntimeHandle } from "../src/index.js";

const spec = { roles: [], entities: [] } as unknown as AppSpec;
const sc: Scenario = {
  id: "SC-AC1",
  title: "Посетитель отправляет заявку",
  actors: {},
  steps: [
    { callFn: { name: "leadCreate", args: { phone: "+79990000000" } } },
    { expect: { status: "created" } },
  ],
};

const runtime = {
  fetch: async () =>
    Response.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Проверьте заполнение полей",
          details: { fields: [{ field: "consent", code: "required", message: "Обязательное поле" }] },
        },
      },
      { status: 422 },
    ),
  loadSystem: async () => undefined,
  outbox: () => [],
  env: { unsafeLocalExec: true },
} as unknown as RuntimeHandle;

describe("G1: evidence of a VALIDATION_FAILED step", () => {
  it("names the field and the rule, never the value", async () => {
    const env = new G1Env({} as postgres.Sql, runtime, spec, "val", "abcd1234", "wizard_runtime");
    const r = await runScenario(env, sc, { seed: null, consent: null, now: new Date(), piiNames: new Set() });
    expect(r.status).toBe("fail");
    expect(r.evidence).toContain("HTTP 422 VALIDATION_FAILED (consent: required)");
    expect(r.evidence).not.toContain("+7999");
  });
});
