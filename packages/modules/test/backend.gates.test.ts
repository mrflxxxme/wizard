// V3-10 acceptance 1 with a database: a backend-mode system (no public pages) passes G0 — schema, migration and RLS in
// the shadow schema, code, build — and G2 — ПДн markup and retention, the permission matrix through the data API and
// direct SQL under RLS — on every CI matrix row and the plans of the measurement briefs; G1 (permission probes,
// acceptance scenarios through the API, render of the staff cabinets) on the brief plans. Same setup as gates.test.ts.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, applyExtensions } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { type GateContext, type GateLevel, runGates } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { CompileSuccess } from "../src/index.js";
import { compiled, matrixPlans, mvpPlans } from "./backend-fixtures.js";
import { ALLOWED, extendBase } from "./extend-fixtures.js";
import { testRegistry } from "./fixtures.js";
import { blockers } from "./g1-runtime.js";

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const registry = testRegistry();

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
const keyPrefix = `v310${randomBytes(3).toString("hex")}`;

beforeAll(async () => {
  db = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  role = `wz_mod_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-modules-backend-"));
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
});

afterAll(async () => {
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Operator data the owner fills before the first publication (G2-PII-06). */
const withOperator = (spec: AppSpec): AppSpec => ({
  ...spec,
  compliance: {
    ...spec.compliance,
    operatorName: "Тестовый оператор V3-10",
    operatorContact: "owner@example.test",
    operatorAddress: "Тестовые данные V3-10, не для публикации",
    // V3-18: a shop's offer also names the seller's ИНН (a valid check digit).
    operatorInn: "7707083893",
  },
});

async function gate(
  level: GateLevel,
  r: Pick<CompileSuccess, "spec" | "files">,
  o: { prevSpec?: AppSpec; env?: "draft" | "prod" } = {},
) {
  const ctx: GateContext = {
    spec: level === "G2" ? withOperator(r.spec) : r.spec,
    prevSpec: o.prevSpec ?? null,
    specVersion: 1,
    files: new Map(Object.entries(r.files)),
    env: o.env ?? "draft",
    systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M2",
    runtime: rt,
    runtimeRole: role,
  };
  return runGates(level, ctx);
}

const pass = (r: Awaited<ReturnType<typeof gate>>, ...ids: string[]) =>
  ids.every((id) => r.checks.some((c) => c.id === id && c.status === "pass"));

/**
 * V3-15: the G2 permission probes no longer collide with the unique slot of bookings (a probe datetime came round to a
 * seed day — 23505) or with the open-issue index of «Выдача» (two roles' create probes on one item — 409 CONFLICT):
 * every row passes PERM-01/02 in backend mode, and the v2 builds of the rows that used to fail pass them too.
 */
const PERM_REGRESSION = [
  "matrix packages — визиты по записи, кабинет посетителя и сотрудники",
  "matrix resources — сотрудники выдают, выдачи клиентам",
  "mvp-09 школьная библиотека",
  "все модули",
];

describe("V3-10: backend systems pass G0 and G2 (ПДн, RLS, migrations) without models", () => {
  const rows = [
    ...matrixPlans(registry).map(([m, n, plan]) => [`matrix ${m} — ${n}`, plan] as const),
    ...mvpPlans(registry).map((p) => [p.name, p.plan] as const),
  ];
  test.each(rows)(
    "%s",
    async (_name, plan) => {
      const r = compiled(plan, registry, { front: "backend" });
      const g0 = await gate("G0", r);
      expect(blockers(g0), "G0").toEqual([]);
      expect(pass(g0, "G0-SPEC-01", "G0-SPEC-05", "G0-MIG-01", "G0-MIG-02", "G0-TS-01", "G0-BUILD-01")).toBe(
        true,
      );
      const g2 = await gate("G2", r);
      expect(blockers(g2), "G2").toEqual([]);
      expect(pass(g2, "G2-PII-01", "G2-PII-02", "G2-PII-03", "G2-PII-05", "G2-PII-06", "G2-PERM-05")).toBe(
        true,
      );
      expect(pass(g2, "G2-PERM-01", "G2-PERM-02")).toBe(true);
    },
    240_000,
  );

  test.each(rows.filter(([name]) => PERM_REGRESSION.includes(name)))(
    "V3-15: the v2 build of %s passes the permission matrix",
    async (_name, plan) => {
      const g2 = await gate("G2", compiled(plan, registry));
      expect(blockers(g2), "G2 v2").toEqual([]);
      expect(pass(g2, "G2-PERM-01", "G2-PERM-02", "G2-PERM-03", "G2-PERM-04")).toBe(true);
    },
    240_000,
  );
});

// G1 checks the spec (permission probes, acceptance scenarios through the API) — the same in both modes, which
// gates.test.ts runs on every matrix row — and renders the pages: here, the staff cabinets of the brief plans.
describe("V3-10: G1 of backend systems — permission probes, acceptance scenarios, staff cabinets render", () => {
  test.each(mvpPlans(registry).map((p) => [p.name, p.plan] as const))(
    "%s",
    async (_name, plan) => {
      const g1 = await gate("G1", compiled(plan, registry, { front: "backend" }));
      expect(blockers(g1), "G1").toEqual([]);
      expect(pass(g1, "G1-RENDER-01")).toBe(true);
    },
    240_000,
  );
});

// V3-10 acceptance 2 with a database: the gates check what the extension operations made of a backend system.
describe("V3-10: an extended system passes the RLS, ПДн and migration gates", () => {
  test("G0 against the module system in prod (additive migration with RLS applies), G1 and G2", async () => {
    const base = extendBase();
    const r = applyExtensions(base.spec, Object.values(ALLOWED), { files: base.files });
    expect(r.rejected).toEqual([]);
    const ext = { spec: r.spec, files: { ...base.files, ...r.files } };
    const g0 = await gate("G0", ext, { prevSpec: base.spec, env: "prod" });
    expect(blockers(g0), "G0").toEqual([]);
    expect(pass(g0, "G0-MIG-01", "G0-MIG-02", "G0-SPEC-05", "G0-FN-01", "G0-TS-01")).toBe(true);
    const g1 = await gate("G1", ext);
    expect(blockers(g1), "G1").toEqual([]);
    const g2 = await gate("G2", ext);
    expect(blockers(g2), "G2").toEqual([]);
    expect(pass(g2, "G2-PII-02", "G2-PII-05", "G2-PERM-01", "G2-PERM-02", "G2-PERM-03", "G2-TG-01")).toBe(
      true,
    );
  }, 240_000);
});
