// G0 orchestration: catalog = gates.yaml#G0.checks; G0-IMP-01/G0-SEC-01 before tsc/esbuild (L3-13);
// time budget → remaining checks error; since/milestone; write_file fast path.
import { join } from "node:path";
import { buildSystem } from "@wizard/build";
import { afterAll, describe, expect, test, vi } from "vitest";
import { typecheck } from "../src/g0/typecheck.js";
import { checkFile, G0_CHECKS, runG0, runGates, shadowSchema } from "../src/index.js";
import { connect, forumCtx, forumFiles, loadYaml, REPO_ROOT } from "./helpers.js";

const db = connect();
afterAll(() => db.end());

describe("catalog", () => {
  test("mirrors specs/quality/gates.yaml#G0.checks (id, severity, since, order)", async () => {
    const doc = (await loadYaml(join(REPO_ROOT, "specs/quality/gates.yaml"))) as {
      G0: { checks: { id: string; severity: string; since?: string }[] };
    };
    const spec = doc.G0.checks.map((c) => ({ id: c.id, severity: c.severity, since: c.since }));
    expect(G0_CHECKS.map((c) => ({ id: c.id, severity: c.severity, since: c.since }))).toEqual(spec);
  });
});

function spies() {
  const build = vi.fn(buildSystem);
  const tsc = vi.fn(typecheck);
  return { build, tsc, deps: { buildSystem: build, typecheck: tsc } };
}

describe("order: AST checks before tsc and esbuild", () => {
  const escapes: [string, string, string][] = [
    [
      "import_env_raw",
      "ui/Evil.tsx",
      'import k from "../../../.env?raw";\nexport default function E() { return <p>{String(k)}</p>; }\n',
    ],
    ["build_path_escape", "functions/lib/x.ts", 'import x from "/etc/passwd";\nexport const y = x;\n'],
    ["dynamic_import", "functions/lib/x.ts", 'export const y = () => import("node:child_process");\n'],
    ["eval_string", "functions/lib/x.ts", 'export const y = () => eval("process.env");\n'],
  ];
  test.each(escapes)("%s blocks G0 and neither tsc nor the build start", async (_name, path, src) => {
    const files = forumFiles();
    files.set(path, src);
    const s = spies();
    const r = await runG0(forumCtx(db, { files }), { deps: s.deps });
    expect(r.passed).toBe(false);
    expect(s.build).not.toHaveBeenCalled();
    expect(s.tsc).not.toHaveBeenCalled();
    const status = (id: string) => r.checks.filter((c) => c.id === id).map((c) => c.status);
    expect([...status("G0-IMP-01"), ...status("G0-SEC-01")]).toContain("fail");
    expect(status("G0-TS-01")).toEqual(["skip"]);
    expect(status("G0-BUILD-01")).toEqual(["skip"]);
  });

  test("a clean revision runs tsc and the build once each", async () => {
    const s = spies();
    const r = await runG0(forumCtx(db), { deps: s.deps });
    expect(r.passed).toBe(true);
    expect(s.tsc).toHaveBeenCalledTimes(1);
    expect(s.build).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe("time budget and since", () => {
  test("exceeded budget: remaining checks error with their severity, gate fails", async () => {
    const r = await runG0(forumCtx(db), { timeBudgetMs: 0 });
    expect(r.passed).toBe(false);
    for (const def of G0_CHECKS.filter((d) => !d.since)) {
      const c = r.checks.find((x) => x.id === def.id);
      expect(c?.status, def.id).toBe("error");
      expect(c?.severity).toBe(def.severity);
      expect(c?.message_ru).toMatch(/^Не удалось проверить/);
    }
  });

  test("aborted signal → error", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runGates("G0", forumCtx(db, { signal: ac.signal }));
    expect(r.passed).toBe(false);
    expect(r.summary.error).toBeGreaterThan(0);
  });

  test("since: M1 warnings are skipped in M0 and default milestone comes from WIZARD_MILESTONE", async () => {
    const prev = process.env.WIZARD_MILESTONE;
    process.env.WIZARD_MILESTONE = "M0";
    try {
      const { milestone: _m, ...ctx } = forumCtx(db);
      const r = await runG0(ctx, { only: ["G0-LINT-01", "G0-SPEC-01"] });
      expect(r.checks.find((c) => c.id === "G0-LINT-01")).toMatchObject({
        status: "skip",
        severity: "warning",
      });
      expect(r.checks.find((c) => c.id === "G0-LINT-01")?.message_ru).toContain("M1");
    } finally {
      if (prev === undefined) delete process.env.WIZARD_MILESTONE;
      else process.env.WIZARD_MILESTONE = prev;
    }
  });

  test("invalid spec: dependent checks are skipped, not crashed", async () => {
    const ctx = forumCtx(db);
    const r = await runG0({ ...ctx, spec: { ...ctx.spec, specVersion: "9" } as never });
    const st = (id: string) => r.checks.find((c) => c.id === id)?.status;
    expect(st("G0-SPEC-01")).toBe("fail");
    for (const id of ["G0-SPEC-02", "G0-MIG-01", "G0-MIG-02", "G0-TS-01", "G0-BUILD-01"])
      expect(st(id), id).toBe("skip");
    expect(r.checks.some((c) => c.status === "error")).toBe(false);
  });
});

describe("write_file fast path (checkFile)", () => {
  test("clean page passes both checks", () => {
    const src = forumFiles().get("ui/Landing.tsx") ?? "";
    expect(checkFile("ui/Landing.tsx", src).map((c) => [c.id, c.status])).toEqual([
      ["G0-IMP-01", "pass"],
      ["G0-SEC-01", "pass"],
    ]);
  });

  test("findings carry file, line and evidence", () => {
    const checks = checkFile(
      "functions/x.ts",
      'import fs from "fs";\n\nexport const a = () => fetch("https://x.example");\n',
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ id: "G0-IMP-01", status: "fail", file: "functions/x.ts", line: 1 }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ id: "G0-SEC-01", status: "fail", line: 3, evidence: "fetch" }),
    );
  });

  test("the same code is allowed or not depending on the area", () => {
    const code = "export const f = () => parent;\n";
    expect(checkFile("functions/lib/a.ts", code).every((c) => c.status === "pass")).toBe(true);
    expect(checkFile("ui/a.tsx", code).find((c) => c.id === "G0-SEC-01")?.status).toBe("fail");
    const log = 'export const f = () => console.log("x");\n';
    expect(checkFile("ui/a.tsx", log).every((c) => c.status === "pass")).toBe(true);
    expect(checkFile("functions/lib/a.ts", log).find((c) => c.id === "G0-SEC-01")?.status).toBe("fail");
  });
});

describe("shadow schema name", () => {
  test("accepts systems.schema_key starting with a digit (12 chars [a-z0-9]); rejects injection", () => {
    expect(shadowSchema("1abcdefghijk")).toBe("app_1abcdefghijk_shadow");
    expect(() => shadowSchema('x"; drop schema')).toThrow();
  });
});
