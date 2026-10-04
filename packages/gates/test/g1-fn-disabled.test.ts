// A 503 FUNCTIONS_DISABLED in a G1 scenario: «нужен WIZARD_UNSAFE_LOCAL_EXEC=1» only when the runtime really has
// neither a sandbox nor unsafe local exec; with the sandbox (M2-19) it was unavailable, and the runtime says why.
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
  title: "Билет нельзя купить сверх лимита потока",
  actors: {},
  steps: [{ callFn: { name: "buyTicket" } }],
};

function runtime(o: { sandbox: boolean; unsafeLocalExec: boolean; message?: string }): RuntimeHandle {
  return {
    fetch: async () =>
      Response.json(
        {
          error: { code: "FUNCTIONS_DISABLED", message: o.message ?? "Функции системы временно недоступны" },
        },
        { status: 503 },
      ),
    loadSystem: async () => undefined,
    outbox: () => [],
    ...(o.sandbox
      ? {
          renderer: async () => ({
            render: async () => ({ kind: "crash", message: "" }),
            close: async () => {},
          }),
        }
      : {}),
    env: { unsafeLocalExec: o.unsafeLocalExec },
  } as RuntimeHandle;
}

const message = async (rt: RuntimeHandle) => {
  const env = new G1Env({} as postgres.Sql, rt, spec, "fnoff", "abcd1234", "wizard_runtime");
  const r = await runScenario(env, sc, { seed: null, consent: null, now: new Date(), piiNames: new Set() });
  expect(r.status).toBe("error");
  return r.message_ru;
};

describe("G1: FUNCTIONS_DISABLED of a function call", () => {
  it("with the sandbox: the sandbox was unavailable, with the runtime's reason", async () => {
    const m = await message(
      runtime({ sandbox: true, unsafeLocalExec: false, message: "Песочница функций перезапускается" }),
    );
    expect(m).toContain("Песочница функций была недоступна: Песочница функций перезапускается");
    expect(m).not.toContain("WIZARD_UNSAFE_LOCAL_EXEC");
  });

  it("a message system code put on its own FUNCTIONS_DISABLED is not quoted", async () => {
    const m = await message(
      runtime({ sandbox: true, unsafeLocalExec: false, message: "Позвоните по номеру +7 900 000-00-00" }),
    );
    expect(m).toContain("Песочница функций была недоступна");
    expect(m).not.toContain("Позвоните");
  });

  it("unsafe local exec without a sandbox: the functions did not load", async () => {
    const m = await message(
      runtime({ sandbox: false, unsafeLocalExec: true, message: "Функции системы не загружены" }),
    );
    expect(m).toContain("Функции системы не загрузились в runtime: Функции системы не загружены");
    expect(m).not.toContain("WIZARD_UNSAFE_LOCAL_EXEC");
  });

  it("neither a sandbox nor unsafe local exec: functions are off, the old hint stays", async () => {
    const m = await message(runtime({ sandbox: false, unsafeLocalExec: false }));
    expect(m).toContain("Функции системы отключены в runtime (нужен WIZARD_UNSAFE_LOCAL_EXEC=1)");
  });
});
