// builder.yaml#context (collapse with hysteresis, stable prefix), #human_diff, generated docs assets, sub-path export.
import { readFileSync } from "node:fs";
import { type AppSpec, applyOps, OP_NAMES } from "@wizard/appspec";
import type { LlmMessage } from "@wizard/llm";
import { describe, expect, test } from "vitest";
import {
  abbreviate,
  BuilderContext,
  humanDiff,
  humanDiffFiles,
  OP_TEMPLATES,
  outline,
  runBuild,
} from "../src/builder/index.js";
import { REPO } from "./builder-helpers.js";

describe("context collapse", () => {
  const turnMessages = (i: number): LlmMessage[] => [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: `c${i}`, name: "write_file", args: { path: `ui/P${i}.tsx`, content: "x".repeat(3500) } },
      ],
    },
    {
      role: "tool",
      toolCallId: `c${i}`,
      toolName: "write_file",
      content: { ok: true, bytes: 3500, warnings: [] },
    },
  ];

  test("40 turns → ≤ 3 boundary shifts; messages 1–2 byte-identical between turns (Chef-style)", async () => {
    const ctx = new BuilderContext("STATIC");
    ctx.session = "SESSION";
    ctx.push({ role: "user", content: "Фаза code" });
    let prefix: string | undefined;
    for (let i = 0; i < 40; i++) {
      await ctx.maybeCollapse(async () => null);
      const msgs = ctx.render();
      const p = JSON.stringify(msgs.slice(0, 2));
      if (prefix !== undefined) expect(p).toBe(prefix);
      prefix = p;
      ctx.push(...turnMessages(i));
    }
    expect(ctx.shifts).toBeGreaterThan(0);
    expect(ctx.shifts).toBeLessThanOrEqual(3);
    expect(ctx.tailChars()).toBeLessThanOrEqual(65536);
    const summary = ctx.render().find((m) => m.role === "user" && m.content.startsWith("Свёрнутая история"));
    expect(summary?.content).toContain("записан ui/P0.tsx (3 КБ)");
    // the last user message survives the collapse
    expect(summary?.content).toContain("Последнее сообщение пользователя:\nФаза code");
  });

  test("the pinned gate report is kept after collapse; tail tool messages keep their assistant", async () => {
    const ctx = new BuilderContext("S", 4000, 1000);
    ctx.pinGateReport("Отчёт проверок G0: упало 1.");
    ctx.push({ role: "user", content: "Отчёт проверок G0: упало 1." });
    for (let i = 0; i < 5; i++) ctx.push(...turnMessages(i));
    expect(await ctx.maybeCollapse(async () => null)).toBe(true);
    const msgs = ctx.render();
    expect(JSON.stringify(msgs)).toContain("Последний отчёт проверок:\\nОтчёт проверок G0: упало 1.");
    const firstTail = msgs.findIndex((m) => m.role === "assistant");
    expect(msgs[firstTail + 1]?.role).toBe("tool");
  });

  test("abbreviations", () => {
    const call = (name: string, args: unknown) => ({ id: "x", name, args });
    expect(
      abbreviate(call("apply_ops", { ops: [{ op: "add_role" }, { op: "add_entity" }], expectedVersion: 0 }), {
        ok: true,
        version: 1,
      }),
    ).toBe("apply_ops v0→v1: 2 операций (add_role, add_entity)");
    expect(
      abbreviate(call("apply_ops", { ops: [] }), {
        ok: false,
        error: { code: "UNKNOWN_ENTITY", issues: [{ path: "/ops/0/entity" }] },
      }),
    ).toBe("apply_ops: ошибка UNKNOWN_ENTITY в /ops/0/entity");
    expect(abbreviate(call("read_file", { path: "spec.json" }), { content: "{}" })).toBe(
      "прочитан spec.json",
    );
    expect(
      abbreviate(call("run_gate", { level: "G0" }), { passed: false, failed: [{ id: "G0-TS-01" }] }),
    ).toBe("G0: упало 1: G0-TS-01");
    expect(abbreviate(call("list_files", {}), { files: [] })).toBe("list_files: ok");
  });

  test("relevant files: priority files first, over-budget files as outline", async () => {
    const ctx = new BuilderContext("S");
    const big = `export default function Big() {\n${"  const a = 1;\n".repeat(1000)}}\n`;
    const files: Record<string, string> = { "ui/Small.tsx": "export const s = 1;\n", "ui/Big.tsx": big };
    ctx.touch("ui/Small.tsx");
    ctx.touch("ui/Big.tsx");
    ctx.setPriority(["ui/Small.tsx"]);
    await ctx.refreshRelevant(async (p) => files[p] ?? null);
    const rel = String(ctx.render()[2]?.content ?? "");
    expect(rel.indexOf("ui/Small.tsx")).toBeLessThan(rel.indexOf("ui/Big.tsx"));
    expect(rel).toContain(outline("ui/Big.tsx", big));
    expect(rel).not.toContain("const a = 1;\n  const a");
  });
});

describe("human diff", () => {
  const forum = JSON.parse(readFileSync(`${REPO}specs/appspec/examples/forum.json`, "utf8")) as AppSpec;

  test("a template for every op of ops.yaml#ops (and unknown)", () => {
    expect(Object.keys(OP_TEMPLATES).sort()).toEqual([...OP_NAMES, "unknown"].sort());
  });

  test("snapshot: forum v1→v2 (a field is added)", () => {
    const ops = [
      {
        op: "add_field",
        entity: "ticket",
        field: { name: "note_text", label: "Примечание", type: "string" },
      },
    ];
    const r = applyOps(forum, ops, 1, { currentVersion: 1 });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(humanDiff(ops, forum, r.spec)).toMatchInlineSnapshot(`
      [
        "В «Билет» добавлено поле «Примечание»",
      ]
    `);
  });

  test("destructive first with ⚠, grouped, ≤ 20 lines with a tail", () => {
    const ops = [
      {
        op: "set_permission",
        role: "partner",
        entity: "promo_code",
        ops: ["read"],
        rowFilter: { partner: "$user.id" },
      },
      { op: "remove_field", entity: "ticket", name: "holder_name" },
      ...Array.from({ length: 25 }, (_, i) => ({
        op: "add_page",
        route: `/p${i}`,
        title: `Экран ${i}`,
        file: `ui/P${i}.tsx`,
        roles: ["organizer"],
      })),
    ];
    const lines = humanDiff(ops, forum, forum);
    expect(lines[0]).toMatch(/^Из «.+» удалено поле «.+» ⚠$/);
    expect(lines[1]).toMatch(/^«Партнёр» теперь может: смотреть — «.+», только свои$/);
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe("и ещё 8 изменений");
  });

  test("files", () => {
    expect(
      humanDiffFiles(
        ["ui/Landing.tsx", "functions/registerTicket.ts", "ui/components/Card.tsx", "functions/lib/x.ts"],
        forum,
      ),
    ).toEqual([
      `Изменён экран «${forum.pages?.find((p) => p.file === "ui/Landing.tsx")?.title}»`,
      "Изменена логика экрана или автоматизации",
      "Изменена вспомогательная логика",
      "Изменён элемент интерфейса «Card»",
    ]);
  });
});

describe("package", () => {
  test("assets/builder.json is fresh (node packages/agents/scripts/gen-builder-assets.mjs)", async () => {
    const gen = (await import(`${REPO}packages/agents/scripts/gen-builder-assets.mjs`)) as {
      buildAssets(): string;
      ASSET_PATH: string;
    };
    expect(JSON.parse(readFileSync(gen.ASSET_PATH, "utf8"))).toEqual(JSON.parse(gen.buildAssets()));
  });

  test("@wizard/agents/builder is a sub-path export; the package index does not re-export agents (L2-19)", async () => {
    const pkg = JSON.parse(readFileSync(`${REPO}packages/agents/package.json`, "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./builder"]).toBe("./src/builder/index.ts");
    // The index carries only shared contracts (text rules, development requests — M2-77), never the agents.
    const index = readFileSync(`${REPO}packages/agents/src/index.ts`, "utf8");
    expect(index).toContain('export const PACKAGE = "@wizard/agents";');
    expect(index).not.toMatch(/from "\.\/(builder|orchestrator|qa)/);
    const mod = (await import("@wizard/agents/builder")) as { runBuild: unknown };
    expect(mod.runBuild).toBe(runBuild);
  });
});
