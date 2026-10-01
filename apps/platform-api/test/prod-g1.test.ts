// M2 prod publish (publish/workflows.ts gate_G1_prod): G1 of the forum through the platform executors exactly as the
// publish step calls it — env prod, milestone M2, no pinned `now` (the wall clock). Regression of forum AC6 (retention
// after advanceTime + runWorkflows): the scenario must not depend on the date the gate runs at
// (docs/reviews/impl-notes/M2-AC6-prod-g1.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createAgentExecutors } from "../src/agents/executors.js";
import { createTestDb, ROOT, startApi, type TestApi } from "./helpers.js";

const forum = JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;

/** Forum code of specs/runtime/examples (bakery excluded), as the e2e stand's builder writes it. */
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

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

beforeAll(async () => {
  tdb = await createTestDb("prodg1", { migrator: true });
  api = await startApi(tdb.url, { config: { unsafeLocalExec: true, milestone: "M2" } });
});
afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
});

describe("gate_G1_prod on the forum (M2)", () => {
  test("G1 at the wall clock passes, AC6 anonymises holder_name after advanceTime + runWorkflows", async () => {
    const ex = createAgentExecutors({ pg: api.deps.pg, config: api.deps.config });
    const ctx = {
      spec: forum,
      prevSpec: null,
      specVersion: 2,
      files: forumFiles(),
      env: "prod" as const,
      systemKey: "prodg1forum",
      db: api.deps.pg,
      milestone: "M2",
    };
    const report = await ex.gates?.("G1", ctx);
    const bad = (report?.checks ?? []).filter((c) => c.status === "fail" || c.status === "error");
    const ac6 = report?.checks.find((c) => c.id === "SC-AC6");
    expect(ac6?.status, JSON.stringify(ac6)).toBe("pass");
    expect(bad, JSON.stringify(bad).slice(0, 3000)).toEqual([]);
    expect(report?.passed).toBe(true);
    // gates.yaml#G1.cleanup: the ephemeral schema is gone after the gate.
    const [{ n } = { n: -1 }] = await api.deps
      .pg`select count(*)::int as n from pg_namespace where nspname like 'app\\_prodg1forum\\_g1\\_%'`;
    expect(n).toBe(0);
  }, 300_000);
});
