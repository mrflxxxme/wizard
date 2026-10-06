// G1 without models for module tests that look into the reports and the runtime outbox (B2-16): a real apps/runtime
// with its own DB role, functions enabled, connectors in outbox mode — the setup of gates.test.ts as a helper.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { type GateContext, type GateReport, runGates } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";

export interface G1Runtime {
  rt: RuntimeApp;
  /** G0 and G1 of a compiled system (reports as they are). */
  gates(spec: AppSpec, files: Record<string, string>): Promise<{ g0: GateReport; g1: GateReport }>;
  close(): Promise<void>;
}

export async function startG1Runtime(prefix: string): Promise<G1Runtime> {
  const db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  const role = `wz_mod_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const root = mkdtempSync(join(tmpdir(), "wz-modules-g1-"));
  const rt = createRuntimeApp({
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
  const ctx = (spec: AppSpec, files: Record<string, string>): GateContext => ({
    spec,
    prevSpec: null,
    specVersion: 1,
    files: new Map(Object.entries(files)),
    env: "draft",
    systemKey: `${prefix}${randomBytes(3).toString("hex")}_${randomBytes(4).toString("hex")}`,
    db,
    milestone: "M1",
    runtime: rt,
    runtimeRole: role,
  });
  return {
    rt,
    gates: async (spec, files) => ({
      g0: await runGates("G0", ctx(spec, files)),
      g1: await runGates("G1", ctx(spec, files)),
    }),
    close: async () => {
      await closeExecutors();
      await db.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
      await db.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await db.end();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Blocker failures of a report, readable in an assertion. */
export const blockers = (r: GateReport): string[] =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id} ${c.file ?? ""}: ${c.message_ru} ${c.evidence ?? ""}`);

/** Status of a check by id (undefined — the check did not run). */
export const statusOf = (r: GateReport, id: string): string | undefined =>
  r.checks.find((c) => c.id === id)?.status;
