// B2-18 in the browser (D76 (6), specs/quality/gates.yaml#G1.browser): every CI matrix row of «Абонементы и пакеты»
// and «Учёт выдачи и ресурсов» and the brief systems mvp-09 and mvp-10 pass G0 and G1 with the goal scenarios of these
// two modules in Chromium (390 and 1280 px, light and dark themes) and every page at 390 px without horizontal scroll:
// a booking writes a visit off, an expired package does not let the visitor book, an issue and its return, the
// overdue mark with the owner's message, the borrower's reminder. The scenarios of the other plan modules are checked
// by their own rows (goals.browser.test.ts).
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { type Check, type GateContext, type GateReport, runG0, runG1 } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CompileSuccess,
  compilePlan,
  matrixPlan,
  packagesManifest,
  resourcesManifest,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";
import { libraryPlan, yogaPlan } from "./fixtures-b218.js";
import { inShard } from "./shard.js";

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
const MINE = new Set(["packages", "resources"]);
const mine = (r: CompileSuccess) => r.scenarios.filter((s) => MINE.has(s.module));
/** B2-47: the owner's list of notifications (GS-notify-3) runs in every row whose plan has notify. */
const checked = (r: CompileSuccess) =>
  r.scenarios.filter((s) => MINE.has(s.module) || s.id === "GS-notify-3");
const keyPrefix = `b218${randomBytes(3).toString("hex")}`;

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
  root = mkdtempSync(join(tmpdir(), "wz-goals-b218-"));
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: serializeQrKeyring(newQrKeyring()) }),
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

function ctx(r: CompileSuccess): GateContext {
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
    goalScenarios: checked(r),
  };
}

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Пример" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

async function ready(r: CompileSuccess): Promise<Check[]> {
  const c = ctx(r);
  const g0 = await runG0(c);
  expect(failed(g0), "G0").toEqual([]);
  const g1 = await runG1(c);
  expect(failed(g1), "G1").toEqual([]);
  expect(g1.checks.some((x) => x.id === "G1-MOBILE-01" && x.status === "pass")).toBe(true);
  for (const s of checked(r))
    expect(g1.checks.find((x) => x.id === `G1-GOAL-${s.id}`)?.status, s.id).toBe("pass");
  return g1.checks;
}

const rows = [packagesManifest, resourcesManifest]
  .flatMap((m) => (m.tests?.matrix ?? []).map((row) => ({ id: m.id, row })))
  // CI splits the rows over three runners (WIZARD_GOALS_SHARD, B2-28).
  .filter((_, i) => inShard(i));

describe.skipIf(!hasChromium)("goal scenarios of packages and resources pass in the browser (B2-18)", () => {
  for (const x of rows)
    test(`matrix ${x.id} — ${x.row.name}`, async () => {
      const r = compiled(matrixPlan(registry, x.id, x.row));
      expect(mine(r).length).toBeGreaterThan(0);
      await ready(r);
    }, 300_000);

  test.skipIf(!inShard(0))(
    "brief mvp-09 (school library): issue, return, overdue, the student's reminder",
    async () => {
      const r = compiled(libraryPlan());
      expect(mine(r).map((s) => s.id)).toEqual([
        "GS-resources-1",
        "GS-resources-2",
        "GS-resources-3",
        "GS-resources-4",
      ]);
      await ready(r);
    },
    300_000,
  );

  test.skipIf(!inShard(1))(
    "brief mvp-10 (yoga subscription): the sale, the reminder, lessons only with a valid subscription",
    async () => {
      const r = compiled(yogaPlan());
      expect(mine(r).map((s) => s.id)).toEqual(["GS-packages-1", "GS-packages-4", "GS-packages-5"]);
      await ready(r);
    },
    300_000,
  );
});
