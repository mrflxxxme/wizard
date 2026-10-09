// V3-32 agent for compatible repositories (product.yaml D77_v3 (4)): compatibility check with the owner's report, the
// repository's rules (or an AGENTS.md proposal), the sandbox contract (network only for install), the agent (callType
// repo_code — RF models only), the techreview of its change (repo_review) — the platform opens the draft PR.

export {
  REPO_AGENT_MAX_TURNS,
  REPO_AGENT_ROUNDS,
  REPO_CODE_CALL_TYPE,
  REPO_TASK_BUDGET_RUB,
  type RepoAgentCode,
  type RepoAgentInput,
  type RepoAgentResult,
  /** The agent: read, search, write or replace a fragment, run_checks (no network), finish → tests → techreview. */
  runRepoAgent,
} from "./agent.js";
export {
  type CompatRun,
  /** Profile → install, build and tests in the sandbox within 10 minutes (Wizard systems: G0, G2) → the report. */
  runCompatCheck,
} from "./check.js";
export {
  /** May the agent take tasks for a repository with this report (compatible or partial)? */
  agentAllowed,
  type CompatReport,
  type CompatVerdict,
  /** The owner's report «что сможем / не сможем» from the profile and the sandbox run. */
  compatReport,
  type Framework,
  MAX_REPO_BYTES,
  MAX_REPO_FILES,
  type PackageManager,
  /** What the repository is: stack, package manager, lockfile, scripts, monorepo packages, rule files (no execution). */
  profileRepo,
  type RepoKind,
  type RepoProfile,
  RULE_FILES,
  SANDBOX_LIMIT_MS,
  type SandboxCheck,
  type SandboxStepName,
  type SandboxStepSummary,
  SUPPORTED_FRAMEWORKS,
  type WorkspacePackage,
} from "./compat.js";
export {
  /** The deterministic part of the techreview of a change: paths, dependencies, secrets, tests, size, build and tests. */
  forbiddenPath,
  MAX_CHANGED_FILES,
  REPO_REVIEW_CALL_TYPE,
  type RepoCheck,
  type RepoFinding,
  type RepoReview,
  repoChecks,
  reviewRepoChange,
} from "./review.js";
export {
  /** AGENTS.md proposed by Wizard when the repository has no rules (code, no model). */
  draftAgentsMd,
  type RepoRules,
  /** AGENTS.md, CLAUDE.md, CONTRIBUTING of the repository (bounded), or the proposed draft. */
  repoRules,
  rulesSection,
} from "./rules.js";
export {
  agentCommand,
  assertPhaseNetwork,
  /** Network of each sandbox phase: registry only for install; build, tests and the agent — none. */
  PHASE_NETWORK,
  type RepoSandbox,
  type SandboxCommand,
  type SandboxNetwork,
  type SandboxPhase,
  type SandboxPlan,
  SandboxPolicyError,
  type SandboxResult,
  type SandboxWorkspace,
  /** Install / build / test commands of a repository by its lockfile and scripts (Wizard systems: G0 and G2). */
  sandboxPlan,
  /** Wizard systems: G0 and the static G2 over the workspace, in process (nothing of the client's runs). */
  wizardGateSandbox,
} from "./sandbox.js";
export {
  applyChanges,
  isSafeRepoPath,
  MAX_TEXT_FILE,
  type RepoFile,
  type RepoFileMode,
  type RepoSnapshot,
  snapshotOf,
  textOf,
} from "./snapshot.js";
