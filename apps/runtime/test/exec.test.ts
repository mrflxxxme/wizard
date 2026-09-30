// Executor process (security/isolation.yaml#M0_M1.mechanism, L3-12): permission model of the child, bundle loading
// rules, memory limit, pool behaviour. Uses hand-written bundles; /api/fn behaviour is in fn.test.ts.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executorFlags, FunctionExecutor, FunctionsLoadError } from "../src/exec/executor.js";

const root = mkdtempSync(join(tmpdir(), "wz-exec-unit-"));
const executors: FunctionExecutor[] = [];

function bundle(name: string, source: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server", "functions.mjs"), source);
  return dir;
}

function executor(dir: string, o: { maxProcesses?: number } = {}): FunctionExecutor {
  const e = new FunctionExecutor({ bundleDir: dir, entities: ["item"], ...o });
  executors.push(e);
  return e;
}

const user = { id: null, role: "__system", attrs: {}, isAdmin: false } as never;

afterAll(() => {
  for (const e of executors) e.close();
  rmSync(root, { recursive: true, force: true });
});

describe("process permissions", () => {
  it("the executor flags deny reads outside the bundle, child_process and worker_threads", () => {
    const dir = bundle("perm", "export default {};");
    writeFileSync(join(dir, "inside.txt"), "ok");
    const probe = join(root, "probe.mjs");
    writeFileSync(
      probe,
      `import { readFileSync } from "node:fs";
const out = {};
const t = (k, f) => { try { f(); out[k] = "allowed"; } catch (e) { out[k] = e.code ?? e.name; } };
t("etcPasswd", () => readFileSync("/etc/passwd"));
t("inside", () => readFileSync(${JSON.stringify(join(dir, "inside.txt"))}));
const cp = await import("node:child_process");
t("childProcess", () => cp.execFileSync("/bin/true"));
const wt = await import("node:worker_threads");
t("worker", () => new wt.Worker("1", { eval: true }));
out.env = Object.keys(process.env).filter((k) => k !== "NODE_CHANNEL_FD" && k !== "NODE_CHANNEL_SERIALIZATION_MODE");
process.stdout.write(JSON.stringify(out));`,
    );
    const flags = executorFlags(dir);
    expect(flags).toContain("--permission");
    expect(flags.some((f) => /allow-(child-process|worker|addons|wasi)/.test(f))).toBe(false);
    const r = spawnSync(process.execPath, [...flags, probe], { env: {}, encoding: "utf8" });
    expect(JSON.parse(r.stdout)).toEqual({
      etcPasswd: "ERR_ACCESS_DENIED",
      inside: "allowed",
      childProcess: "ERR_ACCESS_DENIED",
      worker: "ERR_ACCESS_DENIED",
      env: [],
    });
  });
});

describe("bundle loading", () => {
  it("reports functions with serialized validators", async () => {
    const dir = bundle(
      "ok",
      `import { query, v } from "@wizard/sdk";
export default { f: query({ args: { s: v.string({ pattern: /^a+$/i, max: 3 }), n: v.optional(v.array(v.int({ min: 1 }))) }, handler: async () => 1 }) };`,
    );
    const fns = await executor(dir).functions();
    expect(fns.f?.kind).toBe("query");
    expect(fns.f?.args.s).toMatchObject({ kind: "string", max: 3, pattern: { source: "^a+$", flags: "i" } });
    expect(fns.f?.args.n).toMatchObject({ kind: "optional", isOptional: true, inner: { kind: "array" } });
  });

  it("imports other than @wizard/sdk fail to load", async () => {
    const dir = bundle("fs", `import fs from "node:fs"; export default { f: fs };`);
    await expect(executor(dir).functions()).rejects.toBeInstanceOf(FunctionsLoadError);
  });

  it("a top-level infinite loop does not hang the runtime", async () => {
    const dir = bundle("toploop", "for (;;) {} export default {};");
    await expect(executor(dir).functions()).rejects.toBeInstanceOf(FunctionsLoadError);
  }, 20_000);
});

describe("calls", () => {
  it("a memory bomb ends the process → LIMIT_EXCEEDED, the pool replaces the process", async () => {
    const dir = bundle(
      "mem",
      `import { action, query } from "@wizard/sdk";
export default {
  bomb: action({ args: {}, handler: async () => { const a = []; for (;;) a.push(new Array(1e5).fill({ x: a.length })); } }),
  ok: query({ args: {}, handler: async () => "ok" }),
};`,
    );
    const e = executor(dir, { maxProcesses: 1 });
    await e.functions();
    const err = (await e.run("bomb", "action", {}, user, new Date(), {}, 5000).catch((x) => x)) as {
      code?: string;
    };
    expect(err.code).toBe("LIMIT_EXCEEDED");
    expect(await e.run("ok", "query", {}, user, new Date(), {}, 1000)).toBe("ok");
  }, 20_000);

  it("ctx.db requests reach only the host ctx of the call; unknown ops are refused", async () => {
    const dir = bundle(
      "db",
      `import { query } from "@wizard/sdk";
export default { f: query({ args: {}, handler: async (ctx) => {
  const got = await ctx.db.item.get("1");
  let sched = "none";
  try { await ctx.scheduler.runAfter(1, "f", {}); } catch (e) { sched = "err"; }
  return { got, hasScheduler: typeof ctx.scheduler, sched };
} }) };`,
    );
    const seen: unknown[] = [];
    const hostCtx = {
      db: {
        item: {
          get: async (id: string) => {
            seen.push(id);
            return { id, name: "x" };
          },
        },
      },
      systemDb: {},
    };
    const r = await executor(dir).run("f", "query", {}, user, new Date(), hostCtx, 1000);
    expect(r).toEqual({ got: { id: "1", name: "x" }, hasScheduler: "undefined", sched: "err" });
    expect(seen).toEqual(["1"]);
  });
});
