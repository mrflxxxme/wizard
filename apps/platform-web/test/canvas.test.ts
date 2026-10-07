// B2-25 pure parts of the canvas: the board model from the recorded sketches «клиника», the x-ray chain, the build
// progress adapter (build_stage of the builder v2 and the step_* fallback) and the sketch key (reload by fingerprint).
import { describe, expect, test } from "vitest";
import type { PlanSketch, RunEvent } from "../src/api/types.js";
import { buildProgress, remainingText } from "../src/screens/canvas/buildProgress.js";
import { sketchKey } from "../src/screens/canvas/Canvas.js";
import { blockSignature, canvasModel, materializedCount } from "../src/screens/canvas/model.js";
import { xrayModel } from "../src/screens/canvas/xray.js";
import { loadCanvasFeed } from "./mock/server.js";

const feed = loadCanvasFeed();
const interview = feed.interview.sketch as unknown as PlanSketch;
const plan = feed.plan.sketch as unknown as PlanSketch;
const NAME = feed.system.name;

const events = (list: { type: string; payload: Record<string, unknown> }[]): RunEvent[] =>
  list.map((e, i) => ({
    runId: "r1",
    seq: i + 1,
    type: e.type,
    ts: new Date(Date.UTC(2026, 9, 7, 10, 0, i * 10)).toISOString(),
    payload: e.payload,
  }));

describe("canvas model", () => {
  test("interview sketch: blocks of the candidate modules in three frames, goals and «не входит» as tags", () => {
    const m = canvasModel(interview, NAME);
    expect(m.stage).toBe("interview");
    expect(m.frames.site.map((b) => b.kind)).toEqual(["nav", "hero", "services", "booking"]);
    expect(m.frames.cab.map((b) => b.kind)).toEqual(["goals", "schedule", "client"]);
    expect(m.frames.phone.map((b) => b.kind)).toEqual(["notifications", "mobile"]);
    const tags = [...m.frames.site, ...m.frames.cab, ...m.frames.phone].flatMap((b) => b.tags);
    expect(tags.filter((t) => t.kind === "goal")).toHaveLength(3);
    expect(tags.find((t) => t.kind === "out")?.label).toBe("Оплата лечения на сайте");
    expect(m.accent).toBeNull();
  });

  test("plan sketch: the design direction (B2-37) — theme and fonts on the site's top bar, none in the interview", () => {
    const nav = (sk: PlanSketch) => canvasModel(sk, NAME).frames.site.find((b) => b.kind === "nav");
    expect(nav(interview)?.tags.some((t) => t.label.startsWith("Оформление"))).toBe(false);
    const d = plan.design;
    if (!d) throw new Error("the plan sketch has no design");
    expect(nav(plan)?.tags).toContainEqual({
      kind: "plain",
      label: `Оформление: «${d.themeName}», шрифты ${d.fonts.heading} и ${d.fonts.body}`,
      note: d.mood.join(", "),
    });
  });

  test("plan sketch: landing sections, module screens, business colour; ids stay stable so blocks grow", () => {
    const a = canvasModel(interview, NAME);
    const b = canvasModel(plan, NAME);
    expect(b.accent).toBe("#0F766E");
    expect(b.frames.site.map((x) => x.id)).toEqual([
      "site:nav",
      "site:hero",
      "site:services",
      "site:steps",
      "site:cta",
      "site:booking",
    ]);
    expect(b.order.length).toBeGreaterThan(a.order.length);
    // The blocks of the interview are still there: they are «touched», the new ones are «born».
    for (const id of ["site:nav", "site:services", "site:booking", "cab:goals", "phone:notifications"])
      expect(b.order).toContain(id);
    const out = [...b.frames.site, ...b.frames.cab].flatMap((x) => x.tags).find((t) => t.kind === "out");
    expect(out).toEqual({
      kind: "out",
      label: "Оплата лечения на сайте",
      note: "Оплата в клинике после приёма",
    });
    const booking = b.frames.site.find((x) => x.id === "site:booking");
    expect(booking?.data.specialists).toHaveLength(3);
    expect(b.frames.phone.find((x) => x.kind === "notifications")?.data.channels).toEqual([
      "email",
      "telegram",
    ]);
    const goals = b.frames.cab.find((x) => x.kind === "goals")?.data.metrics as {
      goal: string;
      unit: string;
    }[];
    expect(goals.map((g) => g.goal)).toEqual(["fill_schedule", "reduce_no_shows", "show_offer"]);
  });

  test("an answer before the plan tags its module's block and changes its signature", () => {
    const before = canvasModel(interview, NAME);
    const after = canvasModel(interview, NAME, [{ module: "booking", label: "Несколько" }]);
    const id = "site:booking";
    const sig = (m: typeof before) => blockSignature(m.frames.site.find((b) => b.id === id) as never);
    expect(sig(after)).not.toBe(sig(before));
    expect(after.frames.site.find((b) => b.id === id)?.tags).toContainEqual({
      kind: "plain",
      label: "Несколько",
    });
  });

  test("materialization count follows the build fraction", () => {
    expect(materializedCount(10, 0)).toBe(0);
    expect(materializedCount(10, 0.31)).toBe(4);
    expect(materializedCount(10, 1)).toBe(10);
  });
});

describe("x-ray «Как это работает»", () => {
  test("chain from the site to the cabinet, reminders and the goal panel; who sees data; retention", () => {
    const x = xrayModel(plan, canvasModel(plan, NAME));
    expect(x.steps.map((s) => [s.id, s.anchor])).toEqual([
      ["start", "site:booking"],
      ["cabinet", "cab:schedule"],
      ["remind", "phone:notifications"],
      ["goals", "cab:goals"],
    ]);
    expect(x.steps.find((s) => s.id === "remind")?.label).toBe("Напоминание за сутки и за 2 ч");
    expect(x.edges).toEqual([
      ["start", "cabinet"],
      ["cabinet", "remind"],
      ["remind", "goals"],
    ]);
    expect(x.access).toContainEqual({ who: "Посетитель", what: "Фото сайта, Услуга (часть), Врач" });
    expect(x.retention).toContain("Запись — 1 год, потом обезличиваются");
    expect(x.automations).toContain("Напоминание за 24 ч до визита");
  });
});

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

test("sketch key: a plan reloads the canvas only with a new fingerprint", () => {
  expect(sketchKey(plan)).toBe(sketchKey({ ...plan, warnings: ["другое"] }));
  expect(sketchKey(plan)).not.toBe(sketchKey({ ...plan, fingerprint: "f".repeat(64) }));
  expect(sketchKey(interview)).not.toBe(sketchKey(plan));
});
