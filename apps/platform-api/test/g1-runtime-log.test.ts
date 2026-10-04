// The G1 runtime's log on the worker (M2-19): platform events in a fixed shape only; log lines and texts of the
// AI-generated systems under test never reach the worker log, nor pass for platform events.
import { describe, expect, it } from "vitest";
import { g1RuntimeLogLine } from "../src/agents/g1-sandbox.js";

describe("g1RuntimeLogLine", () => {
  it("platform events pass with fixed-shape fields only", () => {
    expect(
      g1RuntimeLogLine({
        ts: "t",
        level: "error",
        msg: "functions_load_failed",
        system: "g1-ab12cd34",
        env: "draft",
        error: "Позвоните +7 900 000-00-00",
      }),
    ).toEqual({ msg: "functions_load_failed", level: "error", system: "g1-ab12cd34", env: "draft" });
    expect(
      g1RuntimeLogLine({
        level: "error",
        msg: "job_failed",
        system: "g1-x",
        env: "draft",
        job: "notifyAll",
        step: 1,
        code: "MY_CODE",
        attempts: 2,
      }),
    ).toEqual({
      msg: "job_failed",
      level: "error",
      system: "g1-x",
      env: "draft",
      code: "MY_CODE",
      step: 1,
      attempts: 2,
    });
    expect(g1RuntimeLogLine({ level: "error", msg: "job_failed", code: "free text here" })).toEqual({
      msg: "job_failed",
      level: "error",
    });
  });

  it("system code's own log lines are dropped, even when they mimic a platform event", () => {
    expect(
      g1RuntimeLogLine({
        level: "error",
        msg: "functions_load_failed",
        fields: {},
        fn: "buy",
        system: "g1-x",
      }),
    ).toBeNull();
    expect(
      g1RuntimeLogLine({ level: "warn", msg: "sandbox_pod_lost", fn: undefined, fields: undefined }),
    ).toBeNull();
    expect(g1RuntimeLogLine({ level: "error", msg: "что угодно от системы" })).toBeNull();
    expect(g1RuntimeLogLine({ level: "info", msg: "connector" })).toBeNull();
  });
});
