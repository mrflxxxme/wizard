// B2-35 acceptance (browser): every row of the section library matrix (all 20 section types, each layout variant in
// some row, a theme per row) compiles into a system whose landing passes G0 and G1 in Chromium — the landing goal
// scenario (GS-landing-1: the first screen heading is visible on 390 px, the main button leads to the form) and every
// page at 390 px without horizontal scroll (G1-MOBILE-01). Scenarios of the other modules of the row are covered by
// their own programs (B2-24).
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { type GateContext, type GateReport, runG0, runG1 } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileSuccess, compilePlan, LANDING_MATRIX, matrixPlan } from "../src/index.js";
import { testRegistry } from "./fixtures.js";

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
const keyPrefix = `b235${randomBytes(3).toString("hex")}`;

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;

beforeAll(async () => {
  if (!hasChromium) return;
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_sect_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-sections-test-"));
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

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Пример: студия" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

/** «Абонементы и пакеты» without the catalog: the pricing section shows the tariffs (public read added by the landing). */
function packagesPricingPlan(): SystemPlan {
  const plan = matrixPlan(registry, "packages", {
    name: "тарифы на лендинге",
    params: { kind: "both", write_off_on_booking: false, expiry_reminder_days: 0 },
    withModules: ["client_card", "landing"],
  });
  const sections = [...(plan.landing?.sections ?? [])];
  sections.splice(sections.length - 1, 0, {
    type: "pricing",
    variant: "cards",
    content: { title: "Пример: тарифы", note: "Пример: цены из кабинета" },
  });
  return { ...plan, landing: { sections } };
}

const cases: [string, () => unknown][] = [
  ...LANDING_MATRIX.map(
    (row) => [row.name, () => matrixPlan(registry, "landing", row)] as [string, () => unknown],
  ),
  ["цены из тарифов абонементов", packagesPricingPlan],
];

describe.skipIf(!hasChromium)("section library in the browser (B2-35)", () => {
  test.each(cases)(
    "%s: G0, G1 render, GS-landing-1 and 390 px without horizontal scroll",
    async (_name, plan) => {
      const r = compiled(plan());
      const ctx: GateContext = {
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
        goalScenarios: r.scenarios.filter((s) => s.module === "landing"),
      };
      expect(failed(await runG0(ctx)), "G0").toEqual([]);
      const g1 = await runG1(ctx);
      expect(failed(g1), "G1").toEqual([]);
      for (const id of ["G1-RENDER-01", "G1-GOAL-GS-landing-1", "G1-MOBILE-01"])
        expect(g1.checks.find((c) => c.id === id)?.status, id).toBe("pass");
    },
    300_000,
  );
});
