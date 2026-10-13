// B2-25 pure parts of the canvas: the build progress adapter (build_stage of the builder v2 and the step_* fallback) —
// the bar and the ring of the canvas v4 (V4-11) for a v2 build.
import { describe, expect, test } from "vitest";
import type { RunEvent } from "../src/api/types.js";
import { buildProgress, remainingText } from "../src/screens/canvas/buildProgress.js";
import { loadCanvasFeed } from "./mock/server.js";

const feed = loadCanvasFeed();

const events = (list: { type: string; payload: Record<string, unknown> }[]): RunEvent[] =>
  list.map((e, i) => ({
    runId: "r1",
    seq: i + 1,
    type: e.type,
    ts: new Date(Date.UTC(2026, 9, 7, 10, 0, i * 10)).toISOString(),
    payload: e.payload,
  }));

describe("build progress adapter", () => {
  test("build_stage: plain words, n of N, time left, done", () => {
    const all = events(feed.build);
    const half = all.slice(
      0,
      all.findIndex((e) => e.payload.stage === "compile"),
    );
    const p = buildProgress(half);
    expect(p).toMatchObject({ phase: "running", index: 4, total: 7, label: "Подбираю фото" });
    expect(p.fraction).toBeCloseTo(4 / 7);
    expect(p.remainingSec).toBe(95);
    expect(remainingText(p.remainingSec)).toBe("осталось 1 мин 35 с");
    expect(buildProgress(all)).toMatchObject({ phase: "done", fraction: 1, remainingSec: 0 });
  });

  test("retry after a failure: reused stages are counted", () => {
    const reused = feed.build.map((e) =>
      e.type === "build_stage" && e.payload.stage === "plan" && e.payload.status === "done"
        ? { ...e, payload: { ...e.payload, status: "reused" } }
        : e,
    );
    expect(buildProgress(events(reused)).reused).toBe(1);
  });

  test("failure keeps the code, the server words and the stage", () => {
    const p = buildProgress(
      events([
        { type: "run_started", payload: { kind: "build" } },
        { type: "build_stage", payload: { stage: "compile", status: "started", index: 4, total: 6 } },
        { type: "run_failed", payload: { code: "MODULE_BUG", message_ru: "Сбой модуля", retryable: true } },
      ]),
    );
    expect(p.phase).toBe("failed");
    expect(p.failure).toEqual({
      code: "MODULE_BUG",
      message: "Сбой модуля",
      retryable: true,
      stage: "compile",
    });
  });

  test("without build_stage: steps of the run and an estimate from the average step", () => {
    const p = buildProgress(
      events([
        { type: "run_started", payload: { kind: "build" } },
        { type: "plan_ready", payload: { steps: [{ id: "P1" }, { id: "P2" }, { id: "P3" }] } },
        { type: "step_started", payload: { step: "P1", label_ru: "Роли и данные" } },
        { type: "step_finished", payload: { step: "P1" } },
        { type: "step_started", payload: { step: "P2", label_ru: "Экраны" } },
      ]),
    );
    expect(p).toMatchObject({ phase: "running", index: 2, total: 3, label: "Экраны" });
    expect(p.fraction).toBeCloseTo(1 / 3);
    expect(p.remainingSec).toBe(60);
  });
});
