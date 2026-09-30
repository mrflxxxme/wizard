// G1 harness: a real apps/runtime (createRuntimeApp) with its own DB role, functions enabled
// (WIZARD_UNSAFE_LOCAL_EXEC=1 equivalent), artifacts and dev secrets in a temp folder.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import type postgres from "postgres";
import type { GateContext } from "../src/index.js";
import { connect, forumCtx, REPO_ROOT } from "./helpers.js";

export interface G1Harness {
  db: postgres.Sql;
  rt: RuntimeApp;
  role: string;
  ctx(over?: Partial<GateContext>): GateContext;
  close(): Promise<void>;
}

export async function g1Harness(): Promise<G1Harness> {
  const db = connect();
  const role = `wz_g1_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const qrKeyring = serializeQrKeyring(newQrKeyring());
  const root = mkdtempSync(join(tmpdir(), "wz-g1-test-"));
  const rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    // G1 runs in test mode: connector secrets are test values, nothing is written to .data/secrets.
    secrets: () => staticSecretReader({ [QR_SECRET]: qrKeyring }),
    ...(process.env.G1_DEBUG
      ? { log: (l: Record<string, unknown>) => l.level === "error" && console.log(JSON.stringify(l)) }
      : {}),
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
  return {
    db,
    rt,
    role,
    ctx: (over = {}) => forumCtx(db, { runtime: rt, runtimeRole: role, ...over }),
    async close() {
      await closeExecutors();
      await db.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
      await db.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await db.end();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function loadBakery(): { spec: AppSpec; files: Map<string, string> } {
  const spec = JSON.parse(
    readFileSync(join(REPO_ROOT, "specs/appspec/examples/bakery.json"), "utf8"),
  ) as AppSpec;
  const dir = join(REPO_ROOT, "specs/runtime/examples/bakery");
  const files = new Map<string, string>();
  for (const top of ["ui", "functions"]) {
    for (const f of readdirSync(join(dir, top), { recursive: true, encoding: "utf8" }).sort()) {
      if (/\.tsx?$/.test(f))
        files.set(`${top}/${f.split("\\").join("/")}`, readFileSync(join(dir, top, f), "utf8"));
    }
  }
  return { spec, files };
}

export async function g1SchemaCount(db: postgres.Sql): Promise<number> {
  const rows = await db`select count(*)::int as n from pg_namespace where nspname like 'app\\_%\\_g1\\_%'`;
  return Number(rows[0]?.n ?? 0);
}
