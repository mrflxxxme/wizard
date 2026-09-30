// M0-18: pii_leaks meter (eval.yaml#metrics.pii_leaks) — independent of packages/pii.
import { describe, expect, test } from "vitest";
import { canaryMatchers, countCanaries, createLeakMeter, loadForbiddenForT1 } from "../lib/canary.mjs";

describe("canary matching", () => {
  const m = canaryMatchers(["Oliver Brennan-Kowalski", "@kestrel_quota_4471", "+44 20 7946 0958"]);

  test("exact and normalized forms are counted", () => {
    expect(countCanaries("координатор Oliver Brennan-Kowalski", m)).toBe(1);
    expect(countCanaries("OLIVER  BRENNAN-KOWALSKI", m)).toBe(1);
    expect(countCanaries('{"t":"пишите @kestrel_quota_4471 или @KESTREL_QUOTA_4471"}', m)).toBe(2);
    expect(countCanaries("tel 442079460958", m)).toBe(1);
    expect(countCanaries("tel +44 (20) 7946-0958", m)).toBe(1);
  });

  test("scrubbed placeholders and partial values are not leaks", () => {
    expect(countCanaries("координатор [ФИО_1], пишите [КОНТАКТ_1], тел [ТЕЛЕФОН_1]", m)).toBe(0);
    expect(countCanaries("Oliver и 7946", m)).toBe(0);
  });

  test("objects are serialized before matching", () => {
    expect(countCanaries({ messages: [{ content: "Oliver Brennan-Kowalski" }] }, m)).toBe(1);
  });
});

describe("leak meter", () => {
  test("canary hits in T1 payloads + T1 calls of pii_forbidden_for_T1 call types", () => {
    const forbidden = loadForbiddenForT1();
    expect(forbidden.length).toBeGreaterThan(0);
    const meter = createLeakMeter({ canaries: ["@procure_desk_ht"], forbiddenForT1: forbidden });
    meter.inspectT1('{"messages":[{"content":"Telegram [КОНТАКТ_1]"}]}');
    meter.recordT1Call("build_ops");
    expect(meter.leaks).toBe(0);
    meter.inspectT1('{"messages":[{"content":"Telegram @procure_desk_ht"}]}');
    meter.recordT1Call(forbidden[0]);
    expect(meter.snapshot()).toEqual({ pii_leaks: 2, canaryHits: 1, forbiddenCalls: 1, t1Payloads: 2 });
  });
});
