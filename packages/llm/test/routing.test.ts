import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CALL_TYPES,
  type CallType,
  createRegistry,
  createRouter,
  decideTier,
  LlmError,
  type LlmMessage,
  MemoryUsageSink,
  type OrgPolicy,
} from "../src/index.js";
import { buildMatrix, MATRIX_PATH, PAYLOADS, type Row, serialize } from "./gen-routing-matrix.js";

const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8")) as ReturnType<typeof buildMatrix>;
const REG = {
  T1: createRegistry({ buildDefaultTier: "T1" }),
  T0: createRegistry({ buildDefaultTier: "T0" }),
};

const user = (content: string): LlmMessage[] => [
  { role: "system", content: "You build systems." },
  { role: "user", content },
];

function policyOf(ruOnly: boolean, restricted: Row[2]): OrgPolicy {
  return restricted === "absent" ? { ruOnly } : { ruOnly, t1Restricted: restricted };
}

describe("routing matrix (data-boundary.yaml#tests)", () => {
  test("matrix file is up to date with the generator", () => {
    expect(readFileSync(MATRIX_PATH, "utf8")).toBe(serialize(buildMatrix()));
    expect(matrix.rows.length).toBe(25 * 2 * 3 * 4 * 3 * 2);
  });

  test("every row: expected tier and route_reason", () => {
    const failures: string[] = [];
    for (const row of matrix.rows) {
      const [ct, ruOnly, restricted, payload, hint, build, tier, reason] = row;
      const d = decideTier(
        {
          callType: ct as CallType,
          messages: user(PAYLOADS[payload]),
          ...(hint === "absent" ? {} : { containsPiiHint: hint }),
          orgPolicy: policyOf(ruOnly, restricted),
        },
        REG[build],
      );
      if (d.tier !== tier || d.reason !== reason)
        failures.push(`${JSON.stringify(row)} → ${d.tier}/${d.reason}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("policy invariants", () => {
  const all = (fn: (ct: CallType, policy: OrgPolicy, hint: boolean | undefined, text: string) => void) => {
    for (const ct of CALL_TYPES)
      for (const policy of [
        { ruOnly: false, t1Restricted: false },
        { ruOnly: true, t1Restricted: false },
        {},
      ])
        for (const hint of [undefined, false, true])
          for (const text of Object.values(PAYLOADS)) fn(ct, policy, hint, text);
  };

  test("pii_forbidden_for_T1.always never goes to T1; import_mapping without hint=false never goes to T1", () => {
    all((ct, policy, hint, text) => {
      const d = decideTier(
        {
          callType: ct,
          messages: user(text),
          ...(hint === undefined ? {} : { containsPiiHint: hint }),
          orgPolicy: policy,
        },
        REG.T1,
      );
      if (["runtime_ai_extract", "runtime_ai_generate", "support"].includes(ct)) expect(d.tier).toBe("T0");
      if (ct === "import_mapping" && hint !== false) expect(d.tier).toBe("T0");
    });
  });

  test("ruOnly=true → everything T0", () => {
    all((ct, _p, hint, text) => {
      const d = decideTier(
        {
          callType: ct,
          messages: user(text),
          ...(hint === undefined ? {} : { containsPiiHint: hint }),
          orgPolicy: { ruOnly: true, t1Restricted: false },
        },
        REG.T1,
      );
      expect([d.tier, d.reason]).toEqual(["T0", "policy_ru_only"]);
    });
  });

  test.each([
    ["absent", {}],
    ["undefined", { t1Restricted: undefined }],
    ["null", { t1Restricted: null }],
    ["true", { t1Restricted: true }],
  ])("t1Restricted %s → T0 policy_region_restricted (fail-safe, L3-02)", (_n, policy) => {
    for (const ct of CALL_TYPES) {
      const d = decideTier(
        { callType: ct, messages: user(PAYLOADS.none), orgPolicy: policy as OrgPolicy },
        REG.T1,
      );
      expect([d.tier, d.reason]).toEqual(["T0", "policy_region_restricted"]);
    }
    const noPolicy = decideTier({ callType: "plan", messages: user(PAYLOADS.none), orgPolicy: null }, REG.T1);
    expect(noPolicy.reason).toBe("policy_region_restricted");
    const missing = decideTier({ callType: "plan", messages: user(PAYLOADS.none) }, REG.T1);
    expect(missing.reason).toBe("policy_region_restricted");
  });

  test("buildDefaultTier (week0_decision.switch): T0 → no callType gets T1; T1 → build calls get T1", () => {
    const open = { ruOnly: false, t1Restricted: false };
    for (const ct of CALL_TYPES) {
      const t0 = decideTier(
        { callType: ct, messages: user(PAYLOADS.none), containsPiiHint: false, orgPolicy: open },
        REG.T0,
      );
      expect(t0.tier).toBe("T0");
    }
    const t1 = decideTier({ callType: "build_ops", messages: user(PAYLOADS.none), orgPolicy: open }, REG.T1);
    expect([t1.tier, t1.reason]).toEqual(["T1", "default_T1"]);
    const t0 = decideTier({ callType: "build_ops", messages: user(PAYLOADS.none), orgPolicy: open }, REG.T0);
    expect([t0.tier, t0.reason]).toEqual(["T0", "default_T0"]);
  });

  test("T1 decision carries scrubbed messages; counts only, no values", () => {
    const d = decideTier(
      {
        callType: "build_ops",
        messages: user("Напишите Анне Смирновой на anna.smirnova@example.ru"),
        orgPolicy: { ruOnly: false, t1Restricted: false },
      },
      REG.T1,
    );
    expect(d.tier).toBe("T1");
    const payload = JSON.stringify(d.scrubbedMessages);
    expect(payload).not.toContain("anna.smirnova@example.ru");
    expect(payload).toContain("[EMAIL_1]");
    expect(d.dlp.counts.email).toBe(1);
  });

  test("tool results and tool-call args are part of the DLP payload", () => {
    const d = decideTier(
      {
        callType: "fix",
        messages: [
          { role: "user", content: "Исправь ошибку" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "read_file", args: { note: "СНИЛС 112-233-445 95" } }],
          },
          { role: "tool", toolCallId: "c1", toolName: "read_file", content: { text: "ok" } },
        ],
        orgPolicy: { ruOnly: false, t1Restricted: false },
      },
      REG.T1,
    );
    expect([d.tier, d.reason]).toEqual(["T0", "pii_high_risk"]);
  });
});

describe("route() errors", () => {
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "unit", name: "does-not-exist", dir: "/nonexistent" },
    sink: new MemoryUsageSink(),
    env: {},
  });
  const ctx = { orgId: "00000000-0000-4000-8000-000000000001" };

  test("unknown callType → UNKNOWN_CALL_TYPE, no call", async () => {
    await expect(
      router.route({ callType: "chat", messages: user("x"), orgPolicy: {}, ctx }),
    ).rejects.toMatchObject({
      code: "UNKNOWN_CALL_TYPE",
    });
  });

  test("tok_* tokens in a T1 payload → error before sending", async () => {
    const err = await router
      .route({
        callType: "plan",
        messages: user("Клиент tok_person_name_ABCDEFGHIJKLMNOP просит скидку"),
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("PII_TOKEN_IN_T1_PAYLOAD");
  });

  test("budget exhausted → BUDGET_EXCEEDED without a call", async () => {
    await expect(
      router.route({
        callType: "plan",
        messages: user("x"),
        orgPolicy: {},
        ctx: { ...ctx, budget: { capCredits: 10, spentCredits: 10 } },
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});
