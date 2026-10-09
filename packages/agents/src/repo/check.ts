// The compatibility check of a repository (V3-32): the profile of the snapshot, then — when nothing already rules it
// out — install, build and tests in the sandbox within the 10-minute limit (a Wizard system: G0 and the static G2 in
// process), and the owner's report. The workspace stays open for the agent when the caller asks for it.
import {
  type CompatReport,
  compatReport,
  profileRepo,
  type RepoProfile,
  SANDBOX_LIMIT_MS,
  type SandboxCheck,
  type SandboxStepSummary,
} from "./compat.js";
import {
  type RepoSandbox,
  type SandboxPlan,
  type SandboxWorkspace,
  sandboxPlan,
  wizardGateSandbox,
} from "./sandbox.js";
import type { RepoSnapshot } from "./snapshot.js";

const TAIL = 2000;
const tail = (s: string) => (s.length > TAIL ? s.slice(-TAIL) : s);

export interface CompatRun {
  profile: RepoProfile;
  plan: SandboxPlan | null;
  report: CompatReport;
  /** Open when keepOpen and the sandbox run passed: dependencies installed, ready for the agent. */
  workspace: SandboxWorkspace | null;
}

/** The static profile alone rules the repository out (no sandbox run needed). */
function staticallyOut(p: RepoProfile): boolean {
  return compatReport(p, { status: "passed", steps: [], totalMs: 0 }).verdict === "incompatible";
}

const labels = (plan: SandboxPlan | null) => ({
  ...(plan?.install ? { install: plan.install.label } : {}),
  ...(plan?.build ? { build: plan.build.label } : {}),
  ...(plan?.test ? { test: plan.test.label } : {}),
});

/**
 * Profile → (sandbox: install → build → tests, stopping at the first failure or the time limit) → report.
 * `sandbox` null — no runner on this stand (the report says «unchecked»); Wizard systems never need it.
 */
export async function runCompatCheck(
  snapshot: RepoSnapshot,
  sandbox: RepoSandbox | null,
  o: { keepOpen?: boolean; signal?: AbortSignal; unavailableRu?: string } = {},
): Promise<CompatRun> {
  const profile = profileRepo(snapshot);
  const plan = sandboxPlan(profile);
  if (staticallyOut(profile) || !plan)
    return { profile, plan, report: compatReport(profile, null, labels(plan)), workspace: null };
  const runner = profile.kind === "wizard_system" ? wizardGateSandbox() : sandbox;
  if (!runner) {
    const check: SandboxCheck = {
      status: "unavailable",
      steps: [],
      totalMs: 0,
      reason_ru: o.unavailableRu ?? "песочница для сборки JS-проектов на этом стенде не настроена",
    };
    return { profile, plan, report: compatReport(profile, check, labels(plan)), workspace: null };
  }
  const ws = await runner.open(snapshot, o.signal);
  const steps: SandboxStepSummary[] = [];
  let total = 0;
  let status: SandboxCheck["status"] = "passed";
  for (const [step, cmd] of [
    ["install", plan.install],
    ["build", plan.build],
    ["test", plan.test],
  ] as const) {
    if (!cmd) continue;
    const left = SANDBOX_LIMIT_MS - total;
    if (left <= 0) {
      status = "timeout";
      break;
    }
    const r = await ws.run({ ...cmd, timeoutMs: Math.min(cmd.timeoutMs, left) }, o.signal);
    total += r.durationMs;
    steps.push({
      step,
      command: cmd.label,
      ok: r.ok,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      tail: tail(r.output),
    });
    if (r.timedOut || total > SANDBOX_LIMIT_MS) {
      status = "timeout";
      break;
    }
    if (!r.ok) {
      status = "failed";
      break;
    }
  }
  const report = compatReport(profile, { status, steps, totalMs: total }, labels(plan));
  const keep = o.keepOpen && status === "passed";
  if (!keep) await ws.close();
  return { profile, plan, report, workspace: keep ? ws : null };
}
