// B2-11 acceptance: a compiled system passes G0 and G1 with no model — «лендинг + заявки» and every CI matrix row of
// the modules with code (specs/modules/modules.yaml#manifest.tests). Same G1 setup as packages/gates/test/g1-helpers.ts:
// a real apps/runtime with its own DB role, functions enabled, connectors in outbox mode.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { type GateContext, type GateReport, runGates } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type CompileSuccess, compilePlan, MODULES_WITH_CODE, matrixPlan } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const registry = testRegistry();

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
const keyPrefix = `b211${randomBytes(3).toString("hex")}`;

beforeAll(async () => {
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_mod_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-modules-test-"));
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
});

afterAll(async () => {
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

function ctx(spec: AppSpec, files: Record<string, string>): GateContext {
  return {
    spec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(files)),
    env: "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M1",
    runtime: rt,
    runtimeRole: role,
  };
}

const blockers = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id} ${c.file ?? ""}: ${c.message_ru} ${c.evidence ?? ""}`);

async function gates(r: CompileSuccess) {
  const g0 = await runGates("G0", ctx(r.spec, r.files));
  expect(blockers(g0), "G0").toEqual([]);
  const g1 = await runGates("G1", ctx(r.spec, r.files));
  expect(blockers(g1), "G1").toEqual([]);
  return g1;
}

function compiled(plan: unknown): CompileSuccess {
  const r = compilePlan(plan, registry, { appName: "Улыбка" });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

describe("compiled systems pass G0 and G1 without models", () => {
  test("landing + leads: G0, G1 permission probes and render of the landing and the cabinet", async () => {
    const g1 = await gates(compiled(landingLeadsPlan()));
    expect(g1.checks.some((c) => c.id === "G1-RENDER-01" && c.status === "pass")).toBe(true);
  }, 180_000);

  const rows = MODULES_WITH_CODE.flatMap((d) =>
    (d.manifest.tests?.matrix ?? []).map((row) => [d.manifest.id, row.name, row] as const),
  );
  test.each(rows)(
    "matrix %s — %s",
    async (id, _name, row) => {
      await gates(compiled(matrixPlan(registry, id, row)));
    },
    180_000,
  );
});
