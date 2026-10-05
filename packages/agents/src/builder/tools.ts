// Builder tools (agents/builder.yaml#tools): zod schemas → JSON Schema; errors go back to the model as structured
// tool results (ToolFailure → {ok: false, error: {code, message, issues}, data}).
import { OP_NAMES } from "@wizard/appspec";
import { z } from "zod";
import { defineTool, type Tool, ToolFailure } from "../core/index.js";
import { type CapabilityGap, type RecordDevelopmentRequest, reportCapabilityGapTool } from "../gaps.js";
import { capabilityDoc, SDK_TOPICS } from "./docs.js";

export const WRITE_PATH_RE = /^(ui\/[A-Za-z0-9_/-]+\.tsx|functions\/[A-Za-z0-9_/-]+\.ts)$/;
export const MAX_FILE_BYTES = 48 * 1024;
export const SOFT_MAX_LINES = 400;
export const MAX_PLAN_STEPS = 20;

export const planStepSchema = z.object({
  id: z.string().regex(/^P[1-9]\d*$/),
  kind: z.enum(["ops", "code"]),
  title: z.string().trim().min(1).max(200),
  targets: z.array(z.string().max(200)).max(40),
  acRefs: z.array(z.string().regex(/^AC[1-9]\d*$/)).max(20),
});
export type PlanStep = z.infer<typeof planStepSchema>;

export function submitPlanTool(acIds: ReadonlySet<string>) {
  return defineTool({
    name: "submit_plan",
    description:
      "Submit the build plan: ordered ops/code steps with targets and the acceptance criteria they cover.",
    input: z.object({ steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS) }),
    check: ({ steps }) => [
      ...steps.flatMap((s, i) =>
        s.id === `P${i + 1}`
          ? []
          : [
              {
                path: `steps.${i}.id`,
                code: "PLAN_ID",
                message: `Шаги нумеруются по порядку: ожидался P${i + 1}.`,
              },
            ],
      ),
      ...steps.flatMap((s, i) =>
        s.acRefs
          .filter((ac) => !acIds.has(ac))
          .map((ac) => ({
            path: `steps.${i}.acRefs`,
            code: "UNKNOWN_AC",
            message: `Критерия ${ac} нет в карточке: ${[...acIds].join(", ")}.`,
          })),
      ),
    ],
  });
}

export interface ApplyOpsArgs {
  ops: Record<string, unknown>[];
  expectedVersion: number;
  idempotencyKey?: string | undefined;
}

export interface GateToolResult {
  passed: boolean;
  failed: { id: string; message_ru: string; file?: string; line?: number; path?: string; fixHint?: string }[];
  explanations?: unknown[];
}

/** What the tools need from the running builder. */
export interface ToolEnv {
  applyOps(args: ApplyOpsArgs): Promise<{ ok: true; version: number; humanDiff: string[] }>;
  writeFile(path: string, content: string): Promise<{ ok: true; bytes: number; warnings: string[] }>;
  readFile(path: string): Promise<{ content: string }>;
  listFiles(prefix?: "ui/" | "functions/"): Promise<{ files: { path: string; bytes: number }[] }>;
  runGate(level: "G0" | "G1"): Promise<GateToolResult>;
  uiKitDocs(components?: string[]): { docs: string; unknown?: string[] };
  sdkDocs(topic?: (typeof SDK_TOPICS)[number]): { docs: string };
  askOrchestrator(q: { question: string; options?: string[] }): Promise<{ answer: string; source: string }>;
  /** Host method of BuildHost (D73); absent → report_capability_gap records nothing. Read once when tools are built. */
  readonly recordDevelopmentRequest?: RecordDevelopmentRequest | undefined;
  /** A new gap was reported: the builder tells the owner (agent_message). */
  onCapabilityGap?(gap: CapabilityGap): void | Promise<void>;
}

/** Builder tools beyond the golden set (builder.yaml#tools): capability cards and honest gaps (M2-40, M2-77). */
export const EXTRA_BUILDER_TOOLS = ["get_capability", "report_capability_gap"] as const;

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool list
export type AnyTool = Tool<any, any>;

/**
 * Builder tools in builder.yaml#tools order: the 8 tools of the golden fixture, then get_capability and
 * report_capability_gap (EXTRA_BUILDER_TOOLS).
 */
export function builderTools(env: ToolEnv, opts: { applyOps: boolean } = { applyOps: true }): AnyTool[] {
  const tools: AnyTool[] = [
    defineTool({
      name: "apply_ops",
      description:
        "Apply a batch (1..50) of typed AppSpec operations atomically. expectedVersion must equal the current spec version.",
      input: z.object({
        ops: z
          .array(z.looseObject({ op: z.enum(OP_NAMES as [string, ...string[]]) }))
          .min(1)
          .max(50),
        expectedVersion: z.number().int().min(0),
        idempotencyKey: z.string().max(200).optional(),
      }),
      run: (a) => env.applyOps(a as ApplyOpsArgs),
    }),
    defineTool({
      name: "write_file",
      description:
        "Write a complete source file: ui/**.tsx or functions/**.ts, ≤ 48 KB. Checked statically on write.",
      input: z.object({ path: z.string().max(300), content: z.string() }),
      run: (a) => env.writeFile(a.path, a.content),
    }),
    defineTool({
      name: "read_file",
      description: "Read a file of the system, or spec.json, _generated/wizard.d.ts, card.json.",
      input: z.object({ path: z.string().max(300) }),
      run: (a) => env.readFile(a.path),
    }),
    defineTool({
      name: "list_files",
      description: "List files of the system with sizes.",
      input: z.object({ prefix: z.enum(["ui/", "functions/"]).optional() }),
      run: (a) => env.listFiles(a.prefix),
    }),
    defineTool({
      name: "run_gate",
      description:
        "Run a quality gate on the current revision and get the failed checks (G1 needs G0 passed).",
      input: z.object({ level: z.enum(["G0", "G1"]) }),
      run: (a) => env.runGate(a.level),
    }),
    defineTool({
      name: "get_ui_kit_docs",
      description: "@wizard/ui-kit docs: table of contents, or props and behaviour of the given components.",
      input: z.object({ components: z.array(z.string().max(60)).max(20).optional() }),
      run: (a) => env.uiKitDocs(a.components),
    }),
    defineTool({
      name: "get_sdk_docs",
      description: "@wizard/sdk docs: table of contents, or the section on a topic.",
      input: z.object({ topic: z.enum(SDK_TOPICS).optional() }),
      run: (a) => env.sdkDocs(a.topic),
    }),
    defineTool({
      name: "ask_orchestrator",
      description:
        "Ask a question about requirements; answered from the card and defaults, rarely by the user.",
      input: z.object({
        question: z.string().trim().min(1).max(500),
        options: z.array(z.string().trim().min(1).max(120)).min(2).max(4).optional(),
      }),
      run: (a) => env.askOrchestrator(a),
    }),
    defineTool({
      name: "get_capability",
      description: "Read a capability card (recipe of a system class) by id from the table of contents.",
      input: z.object({ id: z.string().trim().min(1).max(60) }),
      run: (a) => {
        const r = capabilityDoc(a.id);
        if ("doc" in r) return r;
        return fail("NOT_FOUND", `Карточки ${a.id} нет; есть: ${r.available.join(", ")}.`);
      },
    }),
    reportCapabilityGapTool({
      record: env.recordDevelopmentRequest,
      onGap: (g) => env.onCapabilityGap?.(g),
    }),
  ];
  return opts.applyOps ? tools : tools.filter((t) => t.name !== "apply_ops");
}

export function fail(
  code: string,
  message: string,
  issues?: { path: string; message: string; code?: string }[],
  data?: unknown,
): never {
  throw new ToolFailure(code, message, issues, data);
}
