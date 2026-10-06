// B2-24 acceptance (D76 (6), specs/quality/gates.yaml#G1.browser): a compiled system is ready when G0 and G1 pass
// with the browser checks — the goal scenarios of its modules in Chromium (390 and 1280 px, light and dark themes) and
// every page at 390 px without horizontal scroll. «лендинг + заявки» end to end («посетитель оставил заявку →
// владелец получил письмо») and every CI matrix row of the modules with code whose scenarios all have programs.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import {
  type Check,
  type GateContext,
  type GateReport,
  GOAL_PROGRAMS,
  type GoalScenarioInput,
  runG0,
  runG1,
} from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileSuccess, compilePlan, MODULES_WITH_CODE, matrixPlan } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const registry = testRegistry();
/** Scenarios of modules with code: stand-ins of the test registry (notify until B2-16) carry no browser programs. */
const WITH_CODE = new Set(MODULES_WITH_CODE.map((d) => d.manifest.id));
const ofCode = (r: CompileSuccess) => r.scenarios.filter((s) => WITH_CODE.has(s.module));
/** Scenarios of modules with code that already have a browser program (programs of the other modules follow B2-24). */
const bound = (r: CompileSuccess) => ofCode(r).filter((s) => GOAL_PROGRAMS[s.id]);
const keyPrefix = `b224${randomBytes(3).toString("hex")}`;

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  if (!hasChromium) return;
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_goal_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-goals-test-"));
  const qrKeyring = serializeQrKeyring(newQrKeyring());
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
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

function ctx(r: CompileSuccess, scenarios: readonly GoalScenarioInput[]): GateContext {
  return {
    spec: r.spec as AppSpec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(r.files)),
    env: "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M1",
    runtime: rt,
    runtimeRole: role,
    browser,
    goalScenarios: scenarios,
  };
}

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Улыбка" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

async function ready(r: CompileSuccess, scenarios = ofCode(r)): Promise<Check[]> {
  const c = ctx(r, scenarios);
  const g0 = await runG0(c);
  expect(failed(g0), "G0").toEqual([]);
  const g1 = await runG1(c);
  expect(failed(g1), "G1").toEqual([]);
  return g1.checks;
}

describe.skipIf(!hasChromium)("goal scenarios of the modules pass in the browser (B2-24)", () => {
  test("landing + leads: «посетитель оставил заявку → владелец получил письмо», 390 px without horizontal scroll", async () => {
    const r = compiled(landingLeadsPlan());
    expect(bound(r).map((s) => s.id)).toEqual(["GS-landing-1", "GS-leads-1", "GS-leads-2"]);
    const checks = await ready(r, bound(r));
    const by = (id: string) => checks.find((c) => c.id === id);
    for (const id of ["G1-GOAL-GS-landing-1", "G1-GOAL-GS-leads-1", "G1-GOAL-GS-leads-2", "G1-MOBILE-01"])
      expect(by(id)?.status, id).toBe("pass");
    expect(by("G1-GOAL-GS-leads-1")?.message_ru).toContain("390 px");
  }, 300_000);

  // Rows whose scenarios all have programs; a scenario without one is listed in the test name and skipped here
  // (G1 reports it as «не связан с проверкой», an error that blocks readiness).
  const rows = MODULES_WITH_CODE.flatMap((d) =>
    (d.manifest.tests?.matrix ?? []).map((row) => {
      const plan = matrixPlan(registry, d.manifest.id, row);
      const r = compilePlan(plan, registry, { appName: "Пример" });
      const unbound = r.ok
        ? ofCode(r)
            .filter((s) => !GOAL_PROGRAMS[s.id])
            .map((s) => s.id)
        : [];
      return { id: d.manifest.id, name: row.name, row, unbound };
    }),
  );
  for (const x of rows)
    test.skipIf(x.unbound.length > 0)(
      `matrix ${x.id} — ${x.name}${x.unbound.length ? ` (нет программы: ${x.unbound.join(", ")})` : ""}`,
      async () => {
        const r = compiled(matrixPlan(registry, x.id, x.row));
        const checks = await ready(r);
        expect(checks.some((c) => c.id === "G1-MOBILE-01" && c.status === "pass")).toBe(true);
        for (const s of ofCode(r))
          expect(checks.find((c) => c.id === `G1-GOAL-${s.id}`)?.status, s.id).toBe("pass");
      },
      300_000,
    );
});
