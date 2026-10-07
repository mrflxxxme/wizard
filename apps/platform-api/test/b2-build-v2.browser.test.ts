// B2-28 acceptance through the API with the platform's own Chromium (gates.yaml#G1.browser.platform): a plan build on
// the recorded answers «barber» (landing + catalog + booking + notify; no network, no money) runs G1 with the goal
// scenarios of its modules in the browser — build_metrics goals.checked = true, every scenario of the plan is a passed
// G1-GOAL-<id> of the stored G1 report, the pages pass G1-MOBILE-01, and the browser part fits its time target.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createRouter, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { B2_SCENARIOS } from "../../../packages/agents/test/build-v2-scenarios.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const fixtureRouter =
  (name: string) =>
  (opts: RouterOptions): Router =>
    createRouter({ ...opts, mode: "fixture", fixture: { suite: "demo", name: `b2/${name}` }, env: {} });

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
beforeAll(async () => {
  if (!hasChromium) return;
  tdb = await createTestDb("b228build", { migrator: true });
  api = await startApi(tdb.url, {
    config: { buildPipeline: "modules", unsafeLocalExec: true, g1Browser: "chromium", g1BrowserSlots: 1 },
    createRouter: fixtureRouter("barber"),
  });
}, 60_000);
afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
});

describe.skipIf(!hasChromium)("plan build through the API with the browser in G1 (B2-28)", () => {
  test("barber: goals.checked = true, every plan scenario passes in G1, 390 px without sideways scroll", async () => {
    const sc = B2_SCENARIOS.find((s) => s.name === "barber");
    if (!sc) throw new Error("barber");
    const created = await api.req("POST", "/systems", { body: { prompt: sc.brief } });
    expect(created.status).toBe(201);
    const systemId: string = created.body.system.id;
    const turn = await waitRun(api, created.body.run.id, ["succeeded", "failed"], 30_000);
    expect(turn.status, JSON.stringify(turn.failure)).toBe("succeeded");
    const ap = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 1 } });
    expect(ap.status).toBe(202);
    const runId: string = ap.body.run.id;
    const run = await waitRun(api, runId, ["succeeded", "failed"], 300_000);
    const g1 = await api.deps.db
      .selectFrom("platform.gate_reports")
      .select(["report", "passed"])
      .where("run_id", "=", runId)
      .where("level", "=", "G1")
      .executeTakeFirst();
    const checks = ((g1?.report as { checks?: { id: string; status: string; message_ru: string }[] })
      ?.checks ?? []) as { id: string; status: string; message_ru: string; evidence?: string }[];
    const browserChecks = checks.filter((c) => c.id.startsWith("G1-GOAL-") || c.id === "G1-MOBILE-01");
    expect(run.status, JSON.stringify({ failure: run.failure, browserChecks })).toBe("succeeded");

    const metrics = (
      await api.deps.db
        .selectFrom("platform.run_events")
        .select("payload")
        .where("run_id", "=", runId)
        .where("type", "=", "build_metrics")
        .executeTakeFirstOrThrow()
    ).payload as { stages: { goals?: { scenarios: number; checked: boolean } } };
    expect(metrics.stages.goals?.checked).toBe(true);
    const goals = browserChecks.filter((c) => c.id.startsWith("G1-GOAL-"));
    expect(goals.length).toBe(metrics.stages.goals?.scenarios);
    // The plan's modules bring their scenarios: booking (4), catalog, landing, notify.
    for (const id of ["GS-landing-1", "GS-booking-1", "GS-booking-3", "GS-booking-4", "GS-notify-1"])
      expect(goals.map((c) => c.id)).toContain(`G1-GOAL-${id}`);
    expect(goals.filter((c) => c.status !== "pass")).toEqual([]);
    expect(goals[0]?.message_ru).toContain("390 px, светлая тема, 1280 px, тёмная тема");
    expect(browserChecks.find((c) => c.id === "G1-MOBILE-01")?.status).toBe("pass");
    expect(g1?.passed).toBe(true);
  }, 400_000);
});
