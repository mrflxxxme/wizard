// Acceptance M0-13: tools are zod schemas; tool errors come back to the model structurally (OpsError-like);
// read_file('spec.json') masks owner-only compliance values (L3-06).
import { type AppSpec, applyOps, emptySpec } from "@wizard/appspec";
import type { LlmMessage, LlmResult, ToolCall } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  type BuildCard,
  type BuildMode,
  builderTools,
  createMemoryHost,
  EXTRA_BUILDER_TOOLS,
  runBuild,
  type ToolEnv,
} from "../src/builder/index.js";
import { cardFor, g1Stub, REPO, report, stop, tc, turn } from "./builder-helpers.js";
import { scriptedRoute } from "./helpers.js";

function baseSpec(): AppSpec {
  const r = applyOps(
    emptySpec("Тест"),
    [
      {
        op: "add_role",
        name: "admin",
        label: "Админ",
        access: "login",
        loginMethods: ["email_otp"],
        isAdmin: true,
      },
      { op: "add_role", name: "guest", label: "Гость", access: "public" },
      {
        op: "add_entity",
        name: "note",
        label: "Заметка",
        fields: [
          { name: "title", label: "Заголовок", type: "string", required: true },
          { name: "email", label: "Почта", type: "email", pii: "basic" },
        ],
        retention: { deleteAfterDays: 30 },
      },
      { op: "set_permission", role: "admin", entity: "note", ops: ["read", "create", "update"] },
      {
        op: "set_acceptance",
        acceptance: [
          {
            id: "AC1",
            text: "Гость не видит заметки",
            check: { type: "permission", role: "guest", entity: "note", op: "read", expect: "deny" },
          },
          {
            id: "AC2",
            text: "Админ создаёт заметку",
            check: { type: "scenario", role: "admin", entity: "note" },
          },
        ],
      },
    ],
    0,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const spec = r.spec;
  spec.compliance = {
    consentTemplateId: "basic",
    policyPage: "/privacy",
    operatorName: "ООО Ромашка",
    operatorContact: "privacy@example.test",
    operatorInn: "7707083893",
    consentText: "Я согласен на обработку",
    retentionWaiver: { reason: "Храним по закону об архивах" },
  };
  return spec;
}

type Content = {
  ok?: boolean;
  error?: { code: string; message: string; issues?: { path: string; code?: string }[] };
} & Record<string, unknown>;

/** Runs one build_ops turn with the given tool calls (mode create/change) and returns the tool results by call id. */
async function probe(
  calls: ToolCall[],
  o: { mode?: BuildMode; card?: BuildCard; files?: [string, string][] } = {},
) {
  const spec = baseSpec();
  const mode = o.mode ?? "create";
  const script: LlmResult[] = [];
  if (mode === "create" || mode === "change")
    script.push(
      turn(
        tc("submit_plan", {
          steps: [{ id: "P1", kind: "ops", title: "Правки", targets: [], acRefs: ["AC1"] }],
        }),
      ),
    );
  script.push(turn(...calls), stop(), stop());
  const { route, inputs } = scriptedRoute(script);
  const mem = createMemoryHost({
    spec,
    version: 1,
    route,
    files: o.files ?? [],
    gates: { G0: async () => report("G0", true), G1: g1Stub },
  });
  const out = await runBuild(mem.host, { card: o.card ?? cardFor(spec), cap: 100, mode });
  const after = inputs[mode === "create" || mode === "change" ? 2 : 1]?.messages ?? [];
  const results = new Map<string, Content>();
  for (const m of after as LlmMessage[])
    if (m.role === "tool") results.set(m.toolCallId, m.content as Content);
  return { results, mem, out, inputs };
}

describe("tool definitions", () => {
  test("tools in builder.yaml order: the golden fixture toolset, then get_capability and report_capability_gap", async () => {
    const lib = (await import(`${REPO}tools/fixtures/lib/golden.mjs`)) as { BUILDER_TOOLS: string[] };
    const tools = builderTools({} as ToolEnv);
    expect(tools.map((t) => t.name)).toEqual([...lib.BUILDER_TOOLS, ...EXTRA_BUILDER_TOOLS]);
    for (const t of tools) {
      expect(t.definition.parameters).toMatchObject({ type: "object" });
      expect(t.description).toMatch(/^[\x20-\x7E…≤]+$/);
    }
    expect(builderTools({} as ToolEnv, { applyOps: false }).map((t) => t.name)).not.toContain("apply_ops");
  });

  test("invalid arguments → INVALID_ARGS with zod issues; > 8 calls in a turn → TOO_MANY_TOOL_CALLS", async () => {
    const many = Array.from({ length: 9 }, (_, i) => tc("list_files", {}, `l${i}`));
    const { results } = await probe([tc("run_gate", { level: "G7" }, "bad"), ...many.slice(1)]);
    expect(results.get("bad")?.error).toMatchObject({ code: "INVALID_ARGS", issues: [{ path: "level" }] });
    expect(results.get("l8")?.error?.code).toBe("TOO_MANY_TOOL_CALLS");
    expect(results.get("l7")?.ok).toBeUndefined();
  });
});

describe("apply_ops", () => {
  test("OpsError comes back structured (code, path, message, allowed) and the spec does not change", async () => {
    const { results, mem } = await probe([
      tc(
        "apply_ops",
        {
          ops: [{ op: "add_field", entity: "nope", field: { name: "x", label: "X", type: "string" } }],
          expectedVersion: 1,
        },
        "a",
      ),
      tc("apply_ops", { ops: [{ op: "set_app", description: "Новое" }], expectedVersion: 7 }, "b"),
      tc("apply_ops", { ops: [{ op: "set_compliance", operatorName: "ООО" }], expectedVersion: 1 }, "c"),
    ]);
    const a = results.get("a");
    expect(a?.error?.code).toBe("UNKNOWN_ENTITY");
    expect(a?.error?.issues?.[0]).toMatchObject({ path: "/ops/0/entity", code: "UNKNOWN_ENTITY" });
    expect((a?.data as { errors: { allowed?: string[] }[] } | undefined)?.errors[0]?.allowed).toEqual([
      "note",
    ]);
    expect(results.get("b")?.error?.code).toBe("VERSION_CONFLICT");
    expect(results.get("c")?.error?.code).toBe("OWNER_ONLY_FIELD");
    expect(mem.state().version).toBe(1);
  });

  test("ok → {ok, version, humanDiff} and ops_applied with summary_ru", async () => {
    const { results, mem } = await probe([
      tc(
        "apply_ops",
        {
          ops: [{ op: "add_field", entity: "note", field: { name: "body", label: "Текст", type: "text" } }],
          expectedVersion: 1,
        },
        "a",
      ),
    ]);
    expect(results.get("a")).toEqual({
      ok: true,
      version: 2,
      humanDiff: ["В «Заметка» добавлено поле «Текст»"],
    });
    expect(mem.events.find((e) => e.type === "ops_applied")?.payload).toEqual({
      revision: 2,
      opsCount: 1,
      opTypes: ["add_field"],
      summary_ru: ["В «Заметка» добавлено поле «Текст»"],
    });
  });

  test("ACCEPTANCE_LOCKED: removing or weakening a card AC in create and change", async () => {
    const ac2 = {
      id: "AC2",
      text: "Админ создаёт заметку",
      check: { type: "scenario", role: "admin", entity: "note" },
    };
    for (const mode of ["create", "change"] as const) {
      const { results } = await probe(
        [
          tc("apply_ops", { ops: [{ op: "set_acceptance", acceptance: [ac2] }], expectedVersion: 1 }, "drop"),
          tc(
            "apply_ops",
            {
              ops: [
                {
                  op: "set_acceptance",
                  acceptance: [
                    {
                      id: "AC1",
                      text: "x",
                      check: {
                        type: "permission",
                        role: "guest",
                        entity: "note",
                        op: "read",
                        expect: "allow",
                      },
                    },
                    ac2,
                  ],
                },
              ],
              expectedVersion: 1,
            },
            "weak",
          ),
        ],
        { mode },
      );
      expect(results.get("drop")?.error).toMatchObject({
        code: "ACCEPTANCE_LOCKED",
        issues: [{ path: "/ops/0/acceptance" }],
      });
      expect(results.get("weak")?.error?.code).toBe("ACCEPTANCE_LOCKED");
    }
  });

  test("PERMISSION_WIDENING in create: unknown role or a grant a deny-AC forbids; rowFilter keeps it narrow", async () => {
    const { results } = await probe([
      tc(
        "apply_ops",
        { ops: [{ op: "set_permission", role: "guest", entity: "note", ops: ["read"] }], expectedVersion: 1 },
        "deny",
      ),
      tc(
        "apply_ops",
        {
          ops: [
            { op: "add_role", name: "boss", label: "Босс", access: "login", loginMethods: ["email_otp"] },
            { op: "set_permission", role: "boss", entity: "note", ops: ["read"] },
          ],
          expectedVersion: 1,
        },
        "role",
      ),
    ]);
    expect(results.get("deny")?.error).toMatchObject({
      code: "PERMISSION_WIDENING",
      issues: [{ path: "/ops/0/ops" }],
    });
    expect(results.get("role")?.error).toMatchObject({
      code: "PERMISSION_WIDENING",
      issues: [{ path: "/ops/1/role" }],
    });
  });
});

describe("write_file", () => {
  const big = `export default function Big() {\n${"  const x = 1;\n".repeat(4000)}  return null;\n}\n`;
  test("path, empty, size and the static G0 check (file not written, error with line)", async () => {
    const long = `export default function Long() {\n${"  // строка\n".repeat(410)}  return null;\n}\n`;
    const { results, mem } = await probe([
      tc("write_file", { path: "src/x.ts", content: "x" }, "path"),
      tc("write_file", { path: "ui/helper.ts", content: "export const a = 1;\n" }, "uits"),
      tc("write_file", { path: "ui/Empty.tsx", content: "  \n" }, "empty"),
      tc("write_file", { path: "ui/Big.tsx", content: big }, "big"),
      tc(
        "write_file",
        { path: "functions/bad.ts", content: 'import fs from "fs";\nexport default fs;\n' },
        "imp",
      ),
      tc(
        "write_file",
        { path: "ui/Ok.tsx", content: "export default function Ok() {\n  return null;\n}\n" },
        "ok",
      ),
      tc("write_file", { path: "ui/Long.tsx", content: long }, "long"),
    ]);
    expect(results.get("path")?.error?.code).toBe("PATH_FORBIDDEN");
    expect(results.get("uits")?.error?.code).toBe("PATH_FORBIDDEN");
    expect(results.get("empty")?.error?.code).toBe("EMPTY_FILE");
    expect(results.get("big")?.error?.code).toBe("FILE_TOO_LARGE");
    const imp = results.get("imp");
    expect(imp?.error?.code).toBe("STATIC_CHECK_FAILED");
    expect(imp?.error?.issues?.[0]).toMatchObject({ path: "functions/bad.ts:1", code: "G0-IMP-01" });
    expect(results.get("ok")).toEqual({ ok: true, bytes: 48, warnings: [] });
    expect(String((results.get("long")?.warnings as string[] | undefined)?.[0])).toContain("строк");
    const files = mem.state().files;
    expect([...files.keys()].sort()).toEqual(["ui/Long.tsx", "ui/Ok.tsx"]);
    const written = mem.events.filter((e) => e.type === "file_written").map((e) => e.payload);
    expect(written).toEqual([
      expect.objectContaining({ path: "ui/Ok.tsx", action: "create", size: 48, revision: 2 }),
      expect.objectContaining({ path: "ui/Long.tsx", action: "create", revision: 2 }),
    ]);
  });

  test("point_edit: only target.file may be written, apply_ops is not offered", async () => {
    const spec = baseSpec();
    const { route, inputs } = scriptedRoute([
      turn(
        tc("write_file", { path: "ui/Other.tsx", content: "export default () => null;\n" }, "other"),
        tc("write_file", { path: "ui/Home.tsx", content: "export default () => 1;\n" }, "home"),
      ),
      stop(),
    ]);
    const mem = createMemoryHost({
      spec,
      version: 1,
      route,
      files: [["ui/Home.tsx", "export default () => null;\n"]],
      gates: { G0: async () => report("G0", true), G1: g1Stub },
    });
    const out = await runBuild(mem.host, {
      card: cardFor(spec),
      cap: 6, // POINT_EDIT_CAP_CREDITS of platform-api: one build_code upper bound alone is ~3 credits
      mode: "point_edit",
      target: {
        wzId: "abcd1234:1",
        componentName: "Button",
        file: "ui/Home.tsx",
        line: 1,
        route: "/",
        instruction: "Поменяй",
      },
    });
    expect(out.status).toBe("succeeded");
    expect(inputs[0]?.tools?.map((t) => t.name)).not.toContain("apply_ops");
    const res = new Map(
      (inputs[1]?.messages ?? []).flatMap((m) =>
        m.role === "tool" ? [[m.toolCallId, m.content as Content]] : [],
      ),
    );
    expect(res.get("other")?.error?.code).toBe("TARGET_ONLY");
    expect(res.get("home")?.ok).toBe(true);
    expect(mem.events.filter((e) => e.type === "file_written").map((e) => e.payload.action)).toEqual([
      "update",
    ]);
  });
});

describe("read_file, list_files, run_gate, docs, ask_orchestrator", () => {
  test("spec.json masks operator fields, consentText and retentionWaiver.reason (L3-06)", async () => {
    const { results } = await probe(
      [
        tc("read_file", { path: "spec.json" }, "spec"),
        tc("read_file", { path: "_generated/wizard.d.ts" }, "dts"),
        tc("read_file", { path: "card.json" }, "card"),
        tc("read_file", { path: "ui/nope.tsx" }, "missing"),
        tc("read_file", { path: "/etc/passwd" }, "outside"),
        tc("read_file", { path: "ui/A.tsx" }, "a"),
        tc("list_files", { prefix: "ui/" }, "list"),
      ],
      {
        files: [
          ["ui/A.tsx", "export default () => null;\n"],
          ["functions/f.ts", "x"],
        ],
      },
    );
    const text = String(results.get("spec")?.content);
    const c = (JSON.parse(text) as AppSpec).compliance;
    expect(c).toEqual({
      consentTemplateId: "basic",
      policyPage: "/privacy",
      operatorName: "[ОПЕРАТОР]",
      operatorContact: "[ОПЕРАТОР]",
      operatorInn: "[ОПЕРАТОР]",
      consentText: "[СКРЫТО]",
      retentionWaiver: { reason: "[СКРЫТО]" },
    });
    for (const secret of ["Ромашка", "privacy@example.test", "7707083893", "согласен", "архивах"])
      expect(text).not.toContain(secret);
    expect(String(results.get("dts")?.content)).toContain('declare module "@wizard/sdk"');
    expect(JSON.parse(String(results.get("card")?.content))).toMatchObject({ title: "Тест" });
    expect(results.get("missing")?.error?.code).toBe("NOT_FOUND");
    expect(results.get("outside")?.error?.code).toBe("NOT_FOUND");
    expect(results.get("a")).toEqual({ content: "export default () => null;\n" });
    expect(results.get("list")).toEqual({ files: [{ path: "ui/A.tsx", bytes: 27 }] });
  });

  test("the session prompt never carries owner-only compliance values", async () => {
    const { inputs } = await probe([tc("list_files", {}, "l")]);
    const all = JSON.stringify(inputs.map((i) => i.messages));
    for (const secret of ["Ромашка", "privacy@example.test", "7707083893", "согласен на", "архивах"])
      expect(all).not.toContain(secret);
  });

  test("run_gate: G1 before G0 → GATE_PRECONDITION; G0 → compressed report", async () => {
    const { results } = await probe([
      tc("run_gate", { level: "G1" }, "g1"),
      tc("run_gate", { level: "G0" }, "g0"),
      tc("run_gate", { level: "G1" }, "g1b"),
    ]);
    expect(results.get("g1")?.error?.code).toBe("GATE_PRECONDITION");
    expect(results.get("g0")).toEqual({ passed: true, failed: [] });
    expect(results.get("g1b")).toEqual({ passed: true, failed: [] });
  });

  test("docs tools and ask_orchestrator", async () => {
    const { results } = await probe([
      tc("get_ui_kit_docs", {}, "toc"),
      tc("get_ui_kit_docs", { components: ["DataTable", "Nope"] }, "dt"),
      tc("get_sdk_docs", { topic: "db" }, "db"),
      tc("get_sdk_docs", {}, "sdk"),
      tc("ask_orchestrator", { question: "Может ли гость видеть заметки?" }, "q1"),
      tc("ask_orchestrator", { question: "Какой цвет кнопки?", options: ["синий", "красный"] }, "q2"),
    ]);
    const toc = String(results.get("toc")?.docs);
    expect(toc).toContain("DataTable");
    expect(toc.length / 3.2).toBeLessThanOrEqual(1500);
    expect(results.get("dt")).toMatchObject({ unknown: ["Nope"] });
    expect(String(results.get("dt")?.docs)).toContain("## DataTable");
    expect(String(results.get("db")?.docs)).toContain("ctx.db");
    expect(String(results.get("sdk")?.docs)).toContain("query");
    expect(results.get("q1")).toMatchObject({ source: "card" });
    expect(String(results.get("q1")?.answer)).toContain("Гость не видит заметки");
    expect(results.get("q2")).toMatchObject({ source: "defaults" });
  });
});
