// M1 hand-over of runs to DBOS (workflows.yaml#execution.M1.engine): platform-api only enqueues the run workflow
// (workflowID = runs.id) and sends messages to it; apps/worker registers and executes the workflow.
import { DBOSClient, type DLogger } from "@dbos-inc/dbos-sdk";
import type { RunDispatcher } from "./queue.js";

/** DBOS application name: scopes workflows, queues and schedules in the dbos schema. */
export const DBOS_APP = "wizard";
/** The workflow apps/worker registers (one per run kind, the body is RunEngine.executeRun). */
export const RUN_WORKFLOW = "wizard.run";
/** workflows.yaml#execution.M1.queues */
export const QUEUE_RUNS = "runs";
export const QUEUE_INTERVIEW = "interview";
/** Schema of the DBOS system tables in the platform database (deploy.yaml#local.postgres.database). */
export const DBOS_SCHEMA = "dbos";

/** Queue and partition of a run: interview turns of one system are strictly sequential (partition = system_id). */
export function queueOf(run: { kind: string; system_id: string | null }): {
  queueName: string;
  queuePartitionKey?: string;
} {
  return run.kind === "interview_turn"
    ? { queueName: QUEUE_INTERVIEW, queuePartitionKey: run.system_id ?? "none" }
    : { queueName: QUEUE_RUNS };
}

/** DBOS internal logging through the platform's allowlist logger (L3-08). */
export function dbosLogger(log: (msg: string, err?: unknown) => void, info?: (msg: string) => void): DLogger {
  const text = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.name : "dbos");
  return {
    info: (e) => info?.(`dbos: ${text(e)}`),
    debug: () => {},
    warn: (e) => log(`dbos warn: ${text(e)}`, e instanceof Error ? e : undefined),
    error: (e) => log("dbos error", e),
  };
}

export async function createDbosDispatcher(o: {
  dbUrl: string;
  log: (msg: string, err?: unknown) => void;
}): Promise<RunDispatcher> {
  const client = await DBOSClient.create({
    systemDatabaseUrl: o.dbUrl,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    applicationName: DBOS_APP,
    systemDatabasePoolSize: 4,
    logger: dbosLogger(o.log),
  });
  return {
    async enqueue(run) {
      await client.enqueue({ ...queueOf(run), workflowName: RUN_WORKFLOW, workflowID: run.id }, run.id);
    },
    async send(runId, topic, message, key) {
      await client.send(runId, message, topic, key);
    },
    close: () => client.destroy(),
  };
}
