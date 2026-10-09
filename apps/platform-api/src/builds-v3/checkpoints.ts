// Checkpoints of the build harness v3 in platform.system_build_checkpoints (V3-11, db.yaml#system_build_checkpoints,
// migration 0037): one row per system and key (stage id, scenario:<id>, questions, requests), upserted after each
// stage and scenario; a repeated build of the system reads them all. And the niche memory of the art director: the
// archetypes of the latest v3 builds of other systems of the same niche.
import type { V3Checkpoint, V3CheckpointStore } from "@wizard/agents/builder";
import type postgres from "postgres";

/** A durable read of the run (BuildHost.once); without one — a plain call. */
export type DurableRead = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
const plainRead: DurableRead = (_name, fn) => fn();

/**
 * Checkpoints of one system's v3 builds; `runId` marks the run that wrote a row. V3-18: `load` is a durable read — a
 * replay after a worker restart gets the checkpoints the run started with, not the ones it saved itself since (else
 * its stages turn «reused» and the step sequence of the workflow diverges).
 */
export function pgCheckpointStore(
  pg: postgres.Sql,
  systemId: string,
  runId: string,
  once: DurableRead = plainRead,
): V3CheckpointStore {
  return {
    load: () =>
      once("v3_checkpoints_load", async () => {
        const rows = await pg<{ checkpoint: V3Checkpoint }[]>`
          select c.checkpoint from platform.system_build_checkpoints c where c.system_id = ${systemId}`;
        return rows.map((r) => r.checkpoint);
      }),
    save: async (cp) => {
      await pg`
        insert into platform.system_build_checkpoints (system_id, key, checkpoint, run_id)
        values (${systemId}, ${cp.key}, ${pg.json(cp as unknown as postgres.JSONValue)}, ${runId})
        on conflict (system_id, key) do update
          set checkpoint = excluded.checkpoint, run_id = excluded.run_id, updated_at = now()`;
    },
  };
}

/** Niche memory (C2 pickArchetype `recent`): archetypes of the latest v3 builds of the niche, newest first. */
export async function recentArchetypes(
  pg: postgres.Sql,
  systemId: string,
  niche: string,
  limit = 5,
): Promise<string[]> {
  const rows = await pg<{ a: string | null }[]>`
    select c.checkpoint -> 'data' ->> 'archetype' as a
    from platform.system_build_checkpoints c
    where c.key = 'design' and c.system_id <> ${systemId} and c.checkpoint -> 'data' ->> 'niche' = ${niche}
    order by c.updated_at desc
    limit ${limit}`;
  return rows.map((r) => r.a).filter((a): a is string => typeof a === "string" && a.length > 0);
}
