// QA test helpers: a real apps/runtime for G1 (same setup as packages/gates/test/g1-helpers.ts: own DB role,
// functions enabled as with WIZARD_UNSAFE_LOCAL_EXEC=1, connectors in outbox mode) and golden build data.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import type { GateContext } from "@wizard/gates";
import { createRouter, MemoryUsageSink, type RouteInput } from "@wizard/llm";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import type postgres from "postgres";
import type { BuildCard } from "../src/builder/index.js";
import { connect, golden, uniqueKey } from "./builder-helpers.js";

export interface G1Harness {
  db: postgres.Sql;
  rt: RuntimeApp;
  role: string;
  ctx(spec: AppSpec, files: ReadonlyMap<string, string>, over?: Partial<GateContext>): GateContext;
  close(): Promise<void>;
}

export async function g1Harness(): Promise<G1Harness> {
  const db = connect();
  const role = `wz_qa_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const qrKeyring = serializeQrKeyring(newQrKeyring());
  const root = mkdtempSync(join(tmpdir(), "wz-qa-test-"));
  const rt = createRuntimeApp({
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
  return {
    db,
    rt,
    role,
    ctx: (spec, files, over = {}) => ({
      spec,
      prevSpec: null,
      specVersion: 1,
      files,
      env: "draft",
      systemKey: uniqueKey("m014"),
      db,
      milestone: "M0",
      runtime: rt,
      runtimeRole: role,
      ...over,
    }),
    async close() {
      await closeExecutors();
      await db.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
      await db.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await db.end();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The golden build (M0-21) as G1 sees it: the spec with the compliance fields the owner/platform fill (consentText
 * from the template is set by the platform, author=system — appspec/ops.yaml#set_compliance), files and the card.
 */
export async function goldenBuild(name: "forum" | "bakery") {
  const g = await golden(name);
  return {
    spec: structuredClone(g.buildSpec),
    files: new Map(g.files.map((f) => [f.path, f.content])),
    card: g.card as BuildCard,
  };
}

/** Demo fixture router with a call log (callType per route call). */
export function demoRouter(name: "forum" | "bakery") {
  const sink = new MemoryUsageSink();
  const router = createRouter({ mode: "fixture", fixture: { suite: "demo", name }, sink, env: {} });
  const calls: string[] = [];
  const route = (input: RouteInput) => {
    calls.push(input.callType);
    return router.route(input);
  };
  return { route, calls, sink };
}

/** Ephemeral G1 schemas of this suite's system keys (prefix m014 / m013) still present. */
export async function g1SchemaCount(db: postgres.Sql, prefix = "m014"): Promise<number> {
  const rows =
    await db`select count(*)::int as n from pg_namespace where nspname like ${`app\\_${prefix}\\_%\\_g1\\_%`}`;
  return Number(rows[0]?.n ?? 0);
}
