// M2-19 acceptance (WORKERD_BIN + Postgres; CI job sandbox): G1 of the forum without WIZARD_UNSAFE_LOCAL_EXEC — its
// functions and its page renders run in workerd through the sandbox orchestrator (pods = local workerd processes),
// reaching the G1 host only over RPC with per-call tokens. The same expectations as prod-g1.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createAgentExecutors } from "../src/agents/executors.js";
import { type G1Sandbox, startG1Sandbox } from "../src/agents/g1-sandbox.js";
import { createTestDb, ROOT, startApi, type TestApi } from "./helpers.js";
import { freePortRange, ProcessKube } from "./workerd-kube.js";

const E2E = process.env.WIZARD_SANDBOX_E2E === "1";
const forum = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;

function forumFiles(): Map<string, string> {
  const base = join(ROOT, "specs/runtime/examples");
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(base, abs);
      if (rel === "bakery") continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(name)) out.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(base);
  return out;
}

describe.skipIf(!E2E)("G1 in the sandbox (M2-19): forum functions and pages in workerd", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let api: TestApi;
  let kube: ProcessKube;
  let sandbox: G1Sandbox | null;

  beforeAll(async () => {
    tdb = await createTestDb("g1sandbox", { migrator: true });
    api = await startApi(tdb.url, { config: { unsafeLocalExec: false, milestone: "M2" } });
    const base = await freePortRange(12);
    const rpcPort = await freePortRange(1);
    kube = new ProcessKube(base);
    sandbox = await startG1Sandbox(
      {
        WIZARD_SANDBOX: "k8s",
        WIZARD_SANDBOX_IMAGE: "unused",
        WIZARD_SANDBOX_RPC_ADDRESS: `127.0.0.1:${rpcPort}`,
        WIZARD_SANDBOX_LISTEN_HOST: "127.0.0.1",
        WIZARD_SANDBOX_HEALTH_PORT: String(base),
        WIZARD_SANDBOX_BASE_PORT: String(base + 1),
        WIZARD_SANDBOX_MAX_PODS: "1",
        WIZARD_G1_RPC_PORT: String(rpcPort),
        WIZARD_G1_RPC_HOST: "127.0.0.1",
        WIZARD_INTERNAL_TOKEN: "t".repeat(40),
      },
      { kube },
    );
  }, 120_000);

  afterAll(async () => {
    await sandbox?.close();
    await kube?.stopAll();
    await api?.dispose();
    await closeExecutors();
    await tdb?.drop();
  });

  test("G1 passes; functions and pages ran in workerd; the pods are gone after the gate", async () => {
    const ex = createAgentExecutors({ pg: api.deps.pg, config: api.deps.config, g1Sandbox: sandbox });
    const report = await ex.gates?.("G1", {
      spec: forum,
      prevSpec: null,
      specVersion: 2,
      files: forumFiles(),
      env: "prod" as const,
      systemKey: "g1sbforum",
      db: api.deps.pg,
      milestone: "M2",
    });
    const bad = (report?.checks ?? []).filter((c) => c.status === "fail" || c.status === "error");
    expect(bad, JSON.stringify(bad).slice(0, 3000)).toEqual([]);
    const render = report?.checks.find((c) => c.id === "G1-RENDER-01");
    expect(render?.status, JSON.stringify(render)).toBe("pass");
    expect(report?.checks.find((c) => c.id === "SC-AC6")?.status).toBe("pass");
    expect(report?.passed).toBe(true);
    expect(kube.procs.size).toBe(0);
  }, 300_000);
});
