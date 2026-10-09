// V3-32 test doubles: a sandbox that runs nothing — it answers each command from the fixture's expectations, keeps the
// workspace files in memory, checks the network of every phase (assertPhaseNetwork) and records what ran with which
// network; a scripted route for the agent and its reviewer (tool calls by order, usage priced like a T0 model).
import type { RouteInput, RouteOutput } from "@wizard/llm";
import {
  assertPhaseNetwork,
  type RepoSandbox,
  type RepoSnapshot,
  type SandboxCommand,
  type SandboxResult,
} from "../src/repo/index.js";
import type { RepoFixture } from "./repo-fixtures.js";

export interface SandboxRun {
  phase: SandboxCommand["phase"];
  network: SandboxCommand["network"];
  argv: readonly string[];
  /** Workspace files at the time of the run. */
  files: Map<string, string>;
}

/** Outcome of a command: from the fixture, or failing when a workspace file carries the marker «BROKEN». */
export class FakeSandbox implements RepoSandbox {
  readonly kind = "fake";
  readonly runs: SandboxRun[] = [];
  opened = 0;
  closed = 0;
  constructor(
    readonly expect: RepoFixture["sandbox"],
    readonly marker = "BROKEN",
  ) {}

  async open(snapshot: RepoSnapshot) {
    this.opened += 1;
    const files = new Map<string, string>();
    for (const [p, f] of snapshot) if (f.text !== null) files.set(p, f.text);
    return {
      run: async (cmd: SandboxCommand): Promise<SandboxResult> => {
        assertPhaseNetwork(cmd);
        this.runs.push({ phase: cmd.phase, network: cmd.network, argv: cmd.argv, files: new Map(files) });
        const step =
          cmd.argv.includes("install") || cmd.argv[1] === "ci"
            ? "install"
            : cmd.argv.includes("build")
              ? "build"
              : "test";
        const e = this.expect[step] ?? { ok: true, ms: 1000 };
        const broken = step !== "install" && [...files].some(([, t]) => t.includes(this.marker));
        const ok = e.ok && !broken;
        const timedOut = e.ms > cmd.timeoutMs;
        return {
          phase: cmd.phase,
          ok: ok && !timedOut,
          exitCode: ok && !timedOut ? 0 : 1,
          timedOut,
          durationMs: Math.min(e.ms, cmd.timeoutMs),
          output: ok
            ? `${cmd.label}: ok`
            : broken
              ? `${cmd.label}\nFAIL src/App.test.tsx\nError: ${this.marker} in the code`
              : `${cmd.label}\nError: step failed`,
        };
      },
      write: async (changes: ReadonlyMap<string, string | null>) => {
        for (const [p, t] of changes) t === null ? files.delete(p) : files.set(p, t);
      },
      close: async () => {
        this.closed += 1;
      },
    };
  }
}

export interface ScriptedCall {
  input: RouteInput;
}

/** A route answering tool calls in order; each answer is [toolName, args][] (one assistant turn). */
export function scriptedRoute(
  turns: ReadonlyArray<ReadonlyArray<[string, unknown]>>,
  o: { model?: (input: RouteInput) => string; creditsMilli?: number } = {},
) {
  const seen: ScriptedCall[] = [];
  let n = 0;
  const route = async (input: RouteInput): Promise<RouteOutput> => {
    seen.push({ input });
    const turn = turns[n++];
    if (!turn) throw new Error(`scripted route: no answer #${n} for ${input.callType}`);
    return {
      tier: "T0",
      model: o.model?.(input) ?? (input.callType === "repo_review" ? "gpt-oss-120b" : "deepseek-v4-pro"),
      result: {
        toolCalls: turn.map(([name, args], i) => ({ id: `c${n}_${i}`, name, args })),
        finishReason: "tool_calls",
      },
      usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 200 },
      creditsCharged: (o.creditsMilli ?? 500) / 1000,
      creditsMilli: o.creditsMilli ?? 500,
      routeReason: "callType_forbidden_T1",
      scrubbed: false,
      ruFallback: false,
    };
  };
  return { route, seen, left: () => turns.length - n };
}
