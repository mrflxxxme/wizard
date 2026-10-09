// The sandbox of the agent for compatible repositories (V3-32): untrusted code — the client's build scripts, tests and
// dependencies — runs only here, never in the platform's process (AGENTS.md: no generated code outside the sandbox).
// Network by phase: install may reach the package registry (through the platform's proxy or mirror), build, tests and
// the agent's own runs have no network at all. The platform provides the runner (security/isolation.yaml: gVisor pod
// in the cloud; locally only with WIZARD_UNSAFE_LOCAL_EXEC=1); Wizard systems are checked by our own gates in process
// (G0 without the database and the static G2 — the same checks the techreview runs), nothing of the client's runs.
import type { AppSpec } from "@wizard/appspec";
import { validateSpec } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { buildBlockers } from "../builder/v2/blockers.js";
import { localGates } from "../builder/v3/techreview/checks.js";
import type { RepoProfile } from "./compat.js";
import { SANDBOX_LIMIT_MS } from "./compat.js";
import type { RepoSnapshot } from "./snapshot.js";

export type SandboxPhase = "install" | "build" | "test" | "agent";
export type SandboxNetwork = "registry" | "none";

/** Network of each phase: only the install reaches the registry. */
export const PHASE_NETWORK: Readonly<Record<SandboxPhase, SandboxNetwork>> = {
  install: "registry",
  build: "none",
  test: "none",
  agent: "none",
};

export interface SandboxCommand {
  phase: SandboxPhase;
  /** argv; for a Wizard system — ["wizard-gate", "G0" | "G2"]. */
  argv: readonly string[];
  network: SandboxNetwork;
  timeoutMs: number;
  /** The command as the owner reads it. */
  label: string;
}

export interface SandboxResult {
  phase: SandboxPhase;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last lines of stdout and stderr (≤ 8 KB). */
  output: string;
}

/** One opened workspace: the repository's files in an isolated directory. */
export interface SandboxWorkspace {
  /** Runs one command; network as the command says (a runner MUST refuse «registry» for any phase but install). */
  run(cmd: SandboxCommand, signal?: AbortSignal): Promise<SandboxResult>;
  /** Writes the agent's changes (text; null deletes). */
  write(changes: ReadonlyMap<string, string | null>): Promise<void>;
  close(): Promise<void>;
}

export interface RepoSandbox {
  /** «gates» (Wizard systems, in process), «process» (local, unsafe), «pod» (gVisor), «fake» (tests). */
  readonly kind: string;
  open(snapshot: RepoSnapshot, signal?: AbortSignal): Promise<SandboxWorkspace>;
}

/** Thrown by a runner asked for network outside the install phase. */
export class SandboxPolicyError extends Error {
  constructor(phase: SandboxPhase) {
    super(`sandbox: network is allowed only in the install phase, not in ${phase}`);
    this.name = "SandboxPolicyError";
  }
}

/** The check every runner makes before a command. */
export function assertPhaseNetwork(cmd: Pick<SandboxCommand, "phase" | "network">): void {
  if (cmd.network !== "none" && cmd.network !== PHASE_NETWORK[cmd.phase])
    throw new SandboxPolicyError(cmd.phase);
}

export interface SandboxPlan {
  install: SandboxCommand | null;
  build: SandboxCommand | null;
  test: SandboxCommand | null;
}

const cmd = (phase: SandboxPhase, argv: string[], label = argv.join(" ")): SandboxCommand => ({
  phase,
  argv,
  network: PHASE_NETWORK[phase],
  timeoutMs: SANDBOX_LIMIT_MS,
  label,
});

/**
 * Commands of a repository: the lockfile's manager installs exactly the lockfile (pnpm --frozen-lockfile, npm ci,
 * yarn --frozen-lockfile / --immutable), then the root scripts build and test (a monorepo without root scripts — every
 * package that has them). null — nothing can run (the report says why).
 */
export function sandboxPlan(p: RepoProfile): SandboxPlan | null {
  if (p.kind === "wizard_system")
    return {
      install: null,
      build: cmd("build", ["wizard-gate", "G0"], "G0 — сборка и типы"),
      test: cmd("test", ["wizard-gate", "G2"], "G2 — права, ПДн и секреты"),
    };
  if (!["js_web", "js_monorepo", "js_other"].includes(p.kind) || !p.packageManager || !p.lockfile)
    return null;
  const pm = p.packageManager;
  const install =
    pm === "pnpm"
      ? ["pnpm", "install", "--frozen-lockfile"]
      : pm === "npm"
        ? ["npm", "ci"]
        : pm === "yarn"
          ? p.yarnBerry
            ? ["yarn", "install", "--immutable"]
            : ["yarn", "install", "--frozen-lockfile"]
          : null;
  if (!install) return null;
  const mono = p.kind === "js_monorepo";
  const script = (name: "build" | "test", rootHas: boolean, anyHas: boolean): string[] | null => {
    if (rootHas) return pm === "npm" && name === "test" ? ["npm", "test"] : [pm, "run", name];
    if (!mono || !anyHas) return null;
    if (pm === "pnpm") return ["pnpm", "-r", "--if-present", "run", name];
    if (pm === "npm") return ["npm", "run", name, "--workspaces", "--if-present"];
    return p.yarnBerry ? ["yarn", "workspaces", "foreach", "-A", "run", name] : null;
  };
  const b = script(
    "build",
    p.scripts.build,
    p.workspaces.some((w) => w.scripts.build),
  );
  const t = script(
    "test",
    p.scripts.test,
    p.workspaces.some((w) => w.scripts.test),
  );
  return {
    install: cmd("install", install),
    build: b ? cmd("build", b) : null,
    test: t ? cmd("test", t) : null,
  };
}

/** The agent's own runs of build and tests: the same commands with no network. */
export const agentCommand = (c: SandboxCommand): SandboxCommand => ({
  ...c,
  phase: "agent",
  network: "none",
});

const gateOutput = (r: GateReport): string =>
  buildBlockers(r)
    .slice(0, 30)
    .map((c) => `${c.id}: ${c.message_ru}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""}`)
    .join("\n");

/**
 * Wizard systems: G0 (build and types without the database) and the static G2 over spec/appspec.json and ui/**,
 * functions/** of the workspace — our own checks in process, the client's code is only compiled, never run.
 */
export function wizardGateSandbox(
  gates: (
    level: "G0" | "G2",
    system: { spec: AppSpec; files: ReadonlyMap<string, string> },
  ) => Promise<GateReport> = localGates,
): RepoSandbox {
  return {
    kind: "gates",
    async open(snapshot) {
      const files = new Map<string, string>();
      for (const [p, f] of snapshot) if (f.text !== null) files.set(p, f.text);
      return {
        async run(c) {
          assertPhaseNetwork(c);
          const started = Date.now();
          const level = c.argv[1] === "G2" ? "G2" : "G0";
          let spec: unknown;
          try {
            spec = JSON.parse(files.get("spec/appspec.json") ?? "");
          } catch {
            return {
              phase: c.phase,
              ok: false,
              exitCode: 1,
              timedOut: false,
              durationMs: 0,
              output: "spec/appspec.json — не JSON",
            };
          }
          const v = validateSpec(spec);
          if (!v.ok)
            return {
              phase: c.phase,
              ok: false,
              exitCode: 1,
              timedOut: false,
              durationMs: Date.now() - started,
              output: v.errors
                .slice(0, 10)
                .map((e) => `${e.path || "/"}: ${e.message_ru}`)
                .join("\n"),
            };
          const sources = new Map(
            [...files].filter(([p]) => p.startsWith("ui/") || p.startsWith("functions/")),
          );
          const r = await gates(level, { spec: v.spec, files: sources });
          // As a build does: blocker checks fail it, except what only the owner fills in Wizard (G2-PII-06).
          const ok = buildBlockers(r).length === 0;
          return {
            phase: c.phase,
            ok,
            exitCode: ok ? 0 : 1,
            timedOut: false,
            durationMs: Date.now() - started,
            output: ok ? `${level}: пройдено` : gateOutput(r),
          };
        },
        async write(changes) {
          for (const [p, t] of changes) t === null ? files.delete(p) : files.set(p, t);
        },
        async close() {},
      };
    },
  };
}
