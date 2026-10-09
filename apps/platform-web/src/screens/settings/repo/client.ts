// Client of /systems/{id}/repo-sync* (specs/platform/api.yaml «V3-31») over the transport of api/client.ts (CSRF double
// submit, Idempotency-Key, ApiError with message_ru, 401 → /login): createApiClient exposes it as `api.repoSync`.
// No token ever reaches the page; a self-managed GitLab's Application Secret is sent once in authorize's body.

export type RepoCheckState = "pending" | "success" | "failure" | "neutral";

export interface RepoSyncLink {
  id: string;
  provider: "github" | "gitlab";
  status: "pending" | "active" | "paused" | "error";
  statusRu: string;
  hostUrl: string;
  repo: { id: string; path: string; webUrl: string | null; defaultBranch: string } | null;
  autoMerge: boolean;
  secretRef: string;
  lastSyncAt: string | null;
  lastError: { code: string; message_ru: string } | null;
  remoteHead: { oid: string; revision: number | null } | null;
  lastPushedRevision: number;
  connectedAt: string;
}

export interface RepoSyncPr {
  revision: number;
  number: number | null;
  url: string | null;
  branch: string;
  state: "open" | "merged" | "closed" | "superseded" | "direct";
  checks: { key: "G0" | "G1" | "G2" | "techreview"; state: RepoCheckState; title: string }[];
  createdAt: string;
}

export interface RepoSyncImport {
  headOid: string;
  status: "pending" | "noop" | "imported" | "rejected";
  revision: number | null;
  baseRevision: number | null;
  prNumber: number | null;
  reason_ru: string | null;
  warnings: string[];
  createdAt: string;
}

export interface RepoSyncState {
  available: boolean;
  providers: { github: boolean; gitlab: boolean; gitlabSelfManaged: boolean };
  link: RepoSyncLink | null;
  prs: RepoSyncPr[];
  imports: RepoSyncImport[];
  queue: { waiting: number; failing: number; stopped: number; nextAttemptAt: string | null };
  publishGate: { required: boolean; mergedRevision: number | null };
}

export interface RepoChoice {
  id: string;
  path: string;
  defaultBranch: string | null;
  private: boolean;
  webUrl: string;
}

export interface RepoSyncClient {
  get(systemId: string): Promise<RepoSyncState>;
  /** Install URL of the platform's GitHub App (the page navigates there). */
  connectGithub(systemId: string): Promise<{ url: string }>;
  /** OAuth authorize URL: gitlab.com without baseUrl, or the owner's instance with its own application. */
  connectGitlab(
    systemId: string,
    body: { baseUrl?: string; clientId?: string; clientSecret?: string },
  ): Promise<{ url: string }>;
  repos(systemId: string): Promise<{ items: RepoChoice[] }>;
  selectRepo(systemId: string, repoId: string): Promise<RepoSyncState>;
  update(systemId: string, body: { autoMerge?: boolean; paused?: boolean }): Promise<RepoSyncState>;
  retry(systemId: string): Promise<RepoSyncState>;
  disconnect(systemId: string): Promise<RepoSyncState>;
}

/** The `call` of createApiClient (mutations get an Idempotency-Key there). */
export type RepoSyncCall = <T>(
  method: string,
  path: string,
  init?: { body?: Record<string, unknown>; idempotencyKey?: string },
) => Promise<T>;

const newKey = (): string => crypto.randomUUID();

export function createRepoSyncClient(call: RepoSyncCall): RepoSyncClient {
  const base = (id: string) => `/systems/${encodeURIComponent(id)}/repo-sync`;
  return {
    get: (id) => call("GET", base(id)),
    connectGithub: (id) => call("POST", `${base(id)}/github`, { idempotencyKey: newKey() }),
    connectGitlab: (id, body) =>
      call("POST", `${base(id)}/gitlab`, { body: { ...body }, idempotencyKey: newKey() }),
    repos: (id) => call("GET", `${base(id)}/repos`),
    selectRepo: (id, repoId) =>
      call("POST", `${base(id)}/repo`, { body: { repoId }, idempotencyKey: newKey() }),
    update: (id, body) => call("PATCH", base(id), { body: { ...body }, idempotencyKey: newKey() }),
    retry: (id) => call("POST", `${base(id)}/retry`, { idempotencyKey: newKey() }),
    disconnect: (id) => call("DELETE", base(id), { idempotencyKey: newKey() }),
  };
}
