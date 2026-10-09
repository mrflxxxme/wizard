// What the sync needs from a code host (V3-31): the repository, pull/merge requests, statuses of the gates on a commit
// and the credentials of git over HTTP. GitHub (App installation) and GitLab (OAuth, self-managed too) implement it;
// GitVerse is the next one (D77 (3)).

export interface ProviderRepo {
  /** Numeric id (GitHub repository id, GitLab project id). */
  id: string;
  /** owner/name or group/subgroup/project. */
  path: string;
  defaultBranch: string | null;
  cloneUrl: string;
  webUrl: string;
  private: boolean;
}

export interface ProviderPr {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  headSha: string | null;
  /** The commit the merge left on the base branch (merge, squash or rebase), when merged. */
  mergeSha: string | null;
  /** A draft PR (merge request) — V3-32: the agent opens only drafts. */
  draft?: boolean;
}

/** State of one gate on a commit: GitHub check run conclusion / GitLab commit status. */
export type CheckState = "pending" | "success" | "failure" | "neutral";

export interface CheckInput {
  /** «Wizard / G0» … — stable per gate. */
  name: string;
  state: CheckState;
  /** One line (GitHub output.title, GitLab description). */
  title: string;
  /** Markdown details (GitHub output.summary; GitLab gets the title only). */
  summary: string;
  detailsUrl: string | null;
}

export interface RepoApi {
  readonly provider: "github" | "gitlab";
  /** Basic credentials of git over HTTP for this repository. */
  gitAuth(): Promise<{ username: string; password: string }>;
  repo(): Promise<ProviderRepo>;
  /** The PR (any state) whose head is `branch`, newest first. */
  findPr(branch: string): Promise<ProviderPr | null>;
  /**
   * Opens a PR. `draft` (V3-32, the agent's PRs): a draft PR (GitHub draft, GitLab «Draft:» title); where the plan of the
   * repository has no drafts (GitHub Free private repositories) the PR opens as a usual one and `draft` is false.
   */
  createPr(i: {
    branch: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<ProviderPr>;
  updatePr(number: number, i: { title?: string; body?: string }): Promise<void>;
  getPr(number: number): Promise<ProviderPr>;
  /** Closes with a comment (a newer Wizard PR replaced it). */
  closePr(number: number, comment: string): Promise<void>;
  /** Merges with a merge commit (keeps Wizard's commits in the base history) only if the head is still `sha`. */
  mergePr(number: number, i: { sha: string; title: string }): Promise<{ sha: string | null }>;
  /** Creates or updates the check of `name` on a commit; returns the id to update it next time (GitHub) or null. */
  setCheck(sha: string, check: CheckInput, previousId: string | null): Promise<string | null>;
}
