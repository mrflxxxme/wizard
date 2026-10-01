// M3-01 (agents/builder.yaml#point_and_edit): a point_edit run on the built forum replays demo/forum.point_edit.jsonl
// offline (fixture mode, no network). The fixture first writes another file — the builder answers TARGET_ONLY — then
// writes target.file only; real G0 passes and the files diff of the run is exactly {target.file}.
import { createRouter, MemoryUsageSink } from "@wizard/llm";
import { afterAll, describe, expect, test } from "vitest";
import { type BuildOutcome, createMemoryHost, executeBuild, type MemoryHost } from "../src/builder/index.js";
import { connect, expectedSpec, g1Stub, golden, stop, tc, turn, uniqueKey } from "./builder-helpers.js";
import { scriptedRoute } from "./helpers.js";

const db = connect();
afterAll(() => db.end());

interface PointEditGolden {
  target: { file: string; componentName: string; route: string };
  instruction: string;
  stray: string;
  before: string;
  after: string;
}

/** Files diff between two trees: changed, added and removed paths. */
function diff(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
}

describe("point_edit on demo/forum.point_edit (fixture replay)", async () => {
  const g = await golden("forum");
  const pe = (g as unknown as { pointEdit: PointEditGolden }).pointEdit;
  const files = new Map(g.files.map((f) => [f.path, f.content]));
  const router = createRouter({
    mode: "fixture",
    fixture: { suite: "demo", name: "forum.point_edit" },
    sink: new MemoryUsageSink(),
    env: {},
  });
  const mem: MemoryHost = createMemoryHost({
    spec: expectedSpec(g),
    version: g.batches.length,
    files,
    route: router,
    db,
    systemKey: uniqueKey("m301"),
    gates: { G1: g1Stub },
  });
  const target = { ...pe.target, wzId: "00000000:0", line: 14, instruction: pe.instruction };
  let out: BuildOutcome;

  test("the run succeeds with G0 passed after a TARGET_ONLY refusal", async () => {
    out = await executeBuild(mem, { card: g.card, cap: 6, mode: "point_edit", target });
    expect(out, JSON.stringify(out)).toMatchObject({ status: "succeeded" });
    const g0 = mem.events.filter((e) => e.type === "gate_result" && e.payload.level === "G0");
    expect(g0.map((e) => e.payload.passed)).toEqual([true]);
    expect(out.status === "succeeded" && out.summary_ru).toContain(pe.target.file);
    // The refused write is answered to the model as TARGET_ONLY (the next call carries the tool result).
    const results = JSON.stringify(mem.calls[1]?.messages ?? []);
    expect(results).toContain("TARGET_ONLY");
    expect(results).toContain(pe.stray);
  }, 120_000);

  test("diff of the run = {target.file}; other files and the spec are untouched", () => {
    const after = mem.state();
    expect(diff(files, after.files)).toEqual([pe.target.file]);
    expect(after.files.get(pe.target.file)).toBe(pe.after);
    expect(after.files.get(pe.stray)).toBe(files.get(pe.stray));
    expect(after.spec).toEqual(expectedSpec(g));
    expect(mem.revisions.every((r) => r.kind === "files")).toBe(true);
    expect(mem.revisions.flatMap((r) => r.files ?? [])).toEqual([pe.target.file]);
    const written = mem.events.filter((e) => e.type === "file_written").map((e) => e.payload.path);
    expect(written).toEqual([pe.target.file]);
  });

  test("apply_ops is not offered; every call is build_code or qa (no plan/ops phases)", () => {
    for (const c of mem.calls) expect(c.tools?.map((t) => t.name) ?? []).not.toContain("apply_ops");
    expect(new Set(mem.calls.map((c) => c.callType))).toEqual(new Set(["build_code"]));
    expect(mem.calls.length).toBe(3);
  });
});

describe("point_edit scope (scripted model)", () => {
  const spec = { app: { name: "Тест" }, roles: [], entities: [], permissions: [], pages: [] };

  test("writes outside target.file are refused every time; only target.file reaches the store", async () => {
    const files = new Map([
      ["ui/A.tsx", "export default function A() { return null; }\n"],
      ["ui/B.tsx", "export default function B() { return null; }\n"],
    ]);
    const mem = createMemoryHost({
      spec: spec as never,
      files,
      route: scriptedRoute([
        turn(
          tc(
            "write_file",
            { path: "ui/B.tsx", content: "export default function B() { return 1; }\n" },
            "w1",
          ),
          tc("write_file", { path: "functions/x.ts", content: "export const x = 1;\n" }, "w2"),
          tc("apply_ops", { ops: [], expectedVersion: 0 }, "o1"),
        ),
        turn(
          tc(
            "write_file",
            { path: "ui/A.tsx", content: "export default function A() { return 1; }\n" },
            "w3",
          ),
        ),
        stop("Готово."),
      ]).route,
      gates: {
        G0: async () => ({ level: "G0", passed: true, checks: [], durationMs: 0 }) as never,
        G1: g1Stub,
      },
    });
    const out = await executeBuild(mem, {
      card: { acceptance: [], roles: [] },
      cap: 3,
      mode: "point_edit",
      target: {
        wzId: "00000000:0",
        componentName: "Button",
        file: "ui/A.tsx",
        line: 1,
        route: "/",
        instruction: "x",
      },
    });
    expect(out.status).toBe("succeeded");
    expect(diff(files, mem.state().files)).toEqual(["ui/A.tsx"]);
    const refused = JSON.stringify(mem.calls[1]?.messages ?? []);
    expect(refused.match(/TARGET_ONLY/g)?.length).toBe(2);
  });
});
