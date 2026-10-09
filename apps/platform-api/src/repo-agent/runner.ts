// The queue of the agent for compatible repositories outside the API (V3-32): apps/worker runs the tasks — the client's
// install, build and tests in the sandbox's gVisor pods, the agent, the draft PRs. platform-api faces the internet and
// with the DBOS engine only enqueues tasks and serves their status (RepoAgent executes: false), so the Kubernetes token
// that creates those pods and reads their ConfigMaps and volumes is held by the worker alone. The worker gets the
// same providers and KMS as the sync (a GitSync whose own queue stays in platform-api) and the platform LLM cap.
import type { Router, RouterOptions } from "@wizard/llm";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { Billing } from "../billing/ledger.js";
import { llmCapOf } from "../billing/llm-cap.js";
import type { Config } from "../config.js";
import type { DB } from "../db/index.js";
import { GitSync } from "../git-sync/service.js";
import type { OpsAlertFn } from "../ops/alert.js";
import type { SecretStore } from "../secrets/store.js";
import type { BlobStore } from "../storage/blobs.js";
import { RepoAgent, type RepoAgentOptions } from "./service.js";

export interface RepoAgentRunnerOptions {
  db: Kysely<DB>;
  pg: postgres.Sql;
  config: Config;
  blobs: BlobStore;
  secrets: SecretStore;
  log: (msg: string, err?: unknown) => void;
  /** Founder alerts of the LLM cap (as in platform-api). */
  alert?: OpsAlertFn;
  createRouter?: (opts: RouterOptions) => Router;
  now?: () => Date;
  /** Tests: the sandbox, the queue timer, the env of the feature. */
  agent?: Pick<RepoAgentOptions, "sandbox" | "tickMs" | "env">;
}

/** Builds the executing RepoAgent of this process and starts its queue (stop() with the process). */
export function startRepoAgentRunner(o: RepoAgentRunnerOptions): RepoAgent {
  const sync = new GitSync({
    db: o.db,
    pg: o.pg,
    blobs: o.blobs,
    config: o.config,
    secrets: o.secrets,
    log: o.log,
    ...(o.agent?.env ? { env: o.agent.env } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  const billing = new Billing({
    exemptOrgs: o.config.billingExemptOrgs,
    llmCap: llmCapOf(o.config, {
      db: o.db,
      ...(o.alert ? { alert: o.alert } : {}),
      ...(o.now ? { now: o.now } : {}),
    }),
    ...(o.now ? { now: o.now } : {}),
  });
  const agent = new RepoAgent({
    db: o.db,
    config: o.config,
    sync,
    billing,
    log: o.log,
    ...(o.createRouter ? { createRouter: o.createRouter } : {}),
    ...o.agent,
  });
  agent.start();
  return agent;
}
