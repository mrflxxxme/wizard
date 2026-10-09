// B2-28/B2-19 time measure (gates.yaml#G1.browser.time_budget_s, D76 «сборка ≤ 5 мин»): the browser part of G1 — goal
// scenarios in two cells over parallel lanes plus every page at 390 px — for a system with every module of the catalog
// with code (allModulesPlan: the service business with packages, issue of resources, members' materials and the goal
// panel with its hints, GS-reports-5 among them) takes ≤ 90 s, every scenario passes and no single run comes near
// its 30 s. On CI (2 vCPU next to Postgres) the bound has a 1.5× allowance.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { testPlatform } from "@wizard/connectors/testing";
import { type BrowserTiming, type GateContext, GOAL_RUN_TIMEOUT_MS, runG0, runG1 } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CATALOG, compilePlan, MODULES_WITH_CODE } from "../src/index.js";
import { allModulesPlan } from "./fixtures.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
/** gates.yaml#G1.browser.time_budget_s: the target of the browser part for a system with every module. */
const TARGET_MS = 90_000;
const BOUND_MS = process.env.CI ? TARGET_MS * 1.5 : TARGET_MS;

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  if (!hasChromium) return;
  db = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  role = `wz_goal_tm_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-goals-time-"));
  const qrKeyring = serializeQrKeyring(newQrKeyring());
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    platform: testPlatform(),
    secrets: () => staticSecretReader({ [QR_SECRET]: qrKeyring }),
    env: {
      authModeDev: true,
      devLogin: false,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  if (!hasChromium) return;
  await browser?.close();
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!hasChromium)("G1 browser time of a system with every module (B2-28, B2-19)", () => {
  test("all 13 modules: 42 goal scenarios × 2 cells over 3 lanes + 390 px — all pass, ≤ 90 s", async () => {
    const plan = allModulesPlan();
    expect(plan.modules.map((m) => m.id).sort()).toEqual(MODULES_WITH_CODE.map((d) => d.manifest.id).sort());
    const r = compilePlan(plan, CATALOG, { appName: "Улыбка" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
    const ids = r.scenarios.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "GS-reports-1",
        "GS-reports-5",
        "GS-packages-2",
        "GS-booking-1",
        "GS-landing-2",
      ]),
    );
    expect(new Set(r.scenarios.map((s) => s.module)).size).toBe(MODULES_WITH_CODE.length);
    expect(r.scenarios.length).toBe(42);
    const ctx: GateContext = {
      spec: r.spec as AppSpec,
      prevSpec: null,
      specVersion: 1,
      files: new Map(Object.entries(r.files)),
      env: "draft",
      systemKey: `b228${randomBytes(4).toString("hex")}`,
      db,
      milestone: "M1",
      runtime: rt,
      runtimeRole: role,
      browser,
      goalScenarios: r.scenarios,
    };
    expect((await runG0(ctx)).passed, "G0").toBe(true);
    let timing: BrowserTiming | undefined;
    const g1 = await runG1(ctx, {
      goals: {
        onTiming: (t) => {
          timing = t;
        },
      },
    });
    const browserChecks = g1.checks.filter((c) => c.id.startsWith("G1-GOAL-") || c.id === "G1-MOBILE-01");
    expect(
      browserChecks
        .filter((c) => c.status !== "pass")
        .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`),
    ).toEqual([]);
    expect(browserChecks.length).toBe(r.scenarios.length + 1);
    // The letters of the G1 outbox are rendered: visitors' letters carry the one-time links GS-booking-3/4 followed
    // (the programs take the link path whenever the letter has one) and the time as a person reads it.
    const texts = rt
      .outbox()
      .filter((m) => m.system?.startsWith(`${ctx.systemKey}_g1_`) && m.integration !== "_platform")
      .map((m) => String((m.payload as { text?: unknown }).text ?? ""));
    expect(texts.some((t) => t.includes("/_wizard/hooks/message/cancel/"))).toBe(true);
    expect(texts.some((t) => t.includes("/_wizard/hooks/message/reschedule/"))).toBe(true);
    expect(texts.some((t) => /[а-я]+ \d{4}, \d\d:\d\d/.test(t))).toBe(true);
    expect(texts.filter((t) => t.includes("{{"))).toEqual([]);
    console.info(`B2-19 G1 browser part, ${r.scenarios.length} scenarios: ${JSON.stringify(timing)}`);
    expect(timing?.runs).toBe(r.scenarios.length * 2);
    expect(timing?.totalMs).toBeLessThanOrEqual(BOUND_MS);
    // The longest single run stays well inside its limit (30 s): a slow scenario is sped up before it times out.
    expect(timing?.slowest?.ms ?? 0).toBeLessThanOrEqual(GOAL_RUN_TIMEOUT_MS / 2);
  }, 300_000);
});
