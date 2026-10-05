// Destructive prod changes (M2-72; product.yaml#decisions.D56_destructive_changes, D72; db.yaml#destructive_changes):
// consequences of publishing a revision counted on live prod data, the owner's confirmation bound to the revision and
// the hash of that list, the check the publish flow makes, and the undo of the last applied change.
import { createHash, randomBytes } from "node:crypto";
import {
  type AppSpec,
  archiveSchemaName,
  type DestructiveChange,
  destructiveChanges,
  destructiveCountSql,
  type FieldType,
  type MigrationPlan,
  planMigration,
  quoteIdent,
} from "@wizard/appspec";
import { ensureSystemRole, schemaName } from "@wizard/runtime";
import type { Selectable } from "kysely";
import type postgres from "postgres";
import { RUNTIME_ROLE } from "../agents/draft.js";
import { type Db, json } from "../db/index.js";
import type { DestructiveChangesTable, SystemsTable } from "../db/types.js";
import { ApiError, invalid } from "../errors.js";
import { RunFailure } from "../runs/types.js";
import { loadRevision, loadSpec } from "../services/revisions.js";
import { consequenceText, isBlocking } from "./texts.js";

type System = Selectable<SystemsTable>;
export type DestructiveRow = Selectable<DestructiveChangesTable>;

/** One line the owner reads before confirming (api.yaml#/components/schemas/DestructiveConsequence). */
export interface Consequence {
  kind: DestructiveChange["kind"];
  entity: string;
  entityLabel: string;
  field?: string;
  fieldLabel?: string;
  fromType?: FieldType;
  toType?: FieldType;
  /** Records the change touches (rows of a removed entity, filled values of a removed or retyped field…). */
  affected: number;
  /** alter_column_type: values that cannot be carried over to the new type (kept only in the archive). */
  unconvertible: number;
  /** Removed values stay in the archive. */
  archived: boolean;
  /** Existing rows break a new rule: the change cannot be published until the data is fixed. */
  blocking: boolean;
  text_ru: string;
}

export interface Consequences {
  revision: number;
  /** Revision whose schema prod has now (schema_hwm_revision); the plan goes from it to `revision`. */
  baseRevision: number | null;
  /** The revision removes or narrows prod data: publishing needs the owner's confirmation. */
  required: boolean;
  blocking: boolean;
  /** Hash of the revision, the base and the set of changes (no counts); a confirmation is valid only for it. */
  hash: string | null;
  changes: Consequence[];
}

/** The prod plan of a revision (hwm spec → revision spec) with destructive steps allowed (they are listed, not run). */
export async function prodPlan(db: Db, sys: System, spec: AppSpec): Promise<MigrationPlan> {
  const hwm = sys.schema_hwm_revision;
  const prev = hwm !== null ? await loadSpec(db, sys, hwm) : null;
  return planMigration(prev, spec, { env: "prod", destructiveConfirmed: true });
}

async function schemaExists(pg: postgres.Sql, schema: string): Promise<boolean> {
  const [r] = await pg`select 1 as x from pg_catalog.pg_namespace where nspname = ${schema}`;
  return r !== undefined;
}

/** Counts every change on app_<key>_prod as its system DB role (FORCE RLS), read-only. */
async function countAll(
  pg: postgres.Sql,
  sys: System,
  plan: MigrationPlan,
  changes: DestructiveChange[],
): Promise<{ affected: number; unconvertible: number }[]> {
  const schema = schemaName(sys.schema_key, "prod");
  if (!(await schemaExists(pg, schema))) return changes.map(() => ({ affected: 0, unconvertible: 0 }));
  const role = await ensureSystemRole(pg, sys.schema_key, "prod", [RUNTIME_ROLE]);
  return (await pg.begin(async (tx) => {
    await tx.unsafe("SET TRANSACTION READ ONLY");
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
    const out: { affected: number; unconvertible: number }[] = [];
    for (const c of changes) {
      const [r] = await tx.unsafe(destructiveCountSql(plan, c, schema));
      out.push({ affected: Number(r?.affected ?? 0), unconvertible: Number(r?.unconvertible ?? 0) });
    }
    return out;
  })) as { affected: number; unconvertible: number }[];
}

/**
 * Hash of what the revision changes, not of the live counts: kind, entity, field, types, default and check of every
 * step, plus the revision and its base. New records after the owner's confirmation do not make it stale (the counts
 * are information; blocking rows are counted again at publish); another set of changes does.
 */
export function consequencesHash(
  revision: number,
  baseRevision: number | null,
  changes: readonly DestructiveChange[],
): string {
  const lines = changes.map((c) => [
    c.kind,
    c.entity,
    c.field ?? null,
    c.fromType ?? null,
    c.toType ?? null,
    c.hasDefault ?? null,
    c.check ?? null,
  ]);
  return createHash("sha256")
    .update(JSON.stringify({ v: 2, revision, baseRevision, lines }))
    .digest("hex");
}

/** Consequences of publishing `revision` of the system now (sys must be fresh: schema_hwm_revision). */
export async function computeConsequences(
  db: Db,
  pg: postgres.Sql,
  sys: System,
  revision: number,
  spec: AppSpec,
): Promise<Consequences> {
  const plan = await prodPlan(db, sys, spec);
  const list = destructiveChanges(plan);
  const baseRevision = sys.schema_hwm_revision;
  if (list.length === 0)
    return { revision, baseRevision, required: false, blocking: false, hash: null, changes: [] };
  const counts = await countAll(pg, sys, plan, list);
  const changes = list.map((c, i): Consequence => {
    const { affected, unconvertible } = counts[i] ?? { affected: 0, unconvertible: 0 };
    return {
      kind: c.kind,
      entity: c.entity,
      entityLabel: c.entityLabel,
      ...(c.field !== undefined ? { field: c.field } : {}),
      ...(c.fieldLabel !== undefined ? { fieldLabel: c.fieldLabel } : {}),
      ...(c.fromType !== undefined ? { fromType: c.fromType } : {}),
      ...(c.toType !== undefined ? { toType: c.toType } : {}),
      affected,
      unconvertible,
      archived: c.archived,
      blocking: isBlocking(c, affected),
      text_ru: consequenceText(c, affected, unconvertible),
    };
  });
  return {
    revision,
    baseRevision,
    required: true,
    blocking: changes.some((c) => c.blocking),
    hash: consequencesHash(revision, baseRevision, list),
    changes,
  };
}

export async function revisionSpec(db: Db, sys: System, revision: number): Promise<AppSpec | undefined> {
  const rev = await loadRevision(db, sys.id, revision);
  return rev ? (rev.spec as unknown as AppSpec) : undefined;
}

/** The newest confirmation of the revision that is still waiting for publication. */
export async function pendingConfirmation(
  db: Db,
  systemId: string,
  revision: number,
): Promise<DestructiveRow | undefined> {
  return db
    .selectFrom("platform.destructive_changes")
    .selectAll()
    .where("system_id", "=", systemId)
    .where("revision", "=", revision)
    .where("status", "=", "confirmed")
    .orderBy("confirmed_at", "desc")
    .executeTakeFirst();
}

export const DESTRUCTIVE_RU = {
  missing:
    "Правка удаляет или меняет данные работающей системы. Владелец должен посмотреть последствия и подтвердить её — затем опубликуйте снова.",
  stale:
    "После подтверждения состав правки изменился (до неё опубликовали другую версию). Посмотрите последствия ещё раз и подтвердите заново.",
  changed: "Состав правки изменился — посмотрите последствия ещё раз и подтвердите заново",
  notApplicable:
    "Подтверждение правки уже не действует — посмотрите последствия ещё раз и подтвердите заново",
  nothing: "В этой правке нет удаления данных — подтверждать нечего",
  undoUnavailable:
    "Отменить можно только последнюю опубликованную правку, удалившую данные, пока после неё ничего не публиковали",
  rollbackBlocked:
    "Эта версия работала с данными, которые потом ушли в архив. Сначала отмените правку, удалившую данные, — кнопка «Отменить правку» в кабинете.",
} as const;

/** Publish check (workflows.yaml#workflows.publish gate_G0_prod, M2-72). JSON-safe: the flow keeps it as a checkpoint. */
export interface PublishCheck {
  state: "none" | "confirmed" | "missing" | "stale" | "blocking";
  message_ru: string | null;
  changeId: string | null;
  archiveTag: string | null;
}

export async function checkForPublish(
  db: Db,
  pg: postgres.Sql,
  sys: System,
  revision: number,
  spec: AppSpec,
): Promise<PublishCheck> {
  const c = await computeConsequences(db, pg, sys, revision, spec);
  if (!c.required) return { state: "none", message_ru: null, changeId: null, archiveTag: null };
  if (c.blocking)
    return {
      state: "blocking",
      message_ru: c.changes.find((x) => x.blocking)?.text_ru ?? DESTRUCTIVE_RU.missing,
      changeId: null,
      archiveTag: null,
    };
  const row = await pendingConfirmation(db, sys.id, revision);
  if (!row) return { state: "missing", message_ru: DESTRUCTIVE_RU.missing, changeId: null, archiveTag: null };
  if (row.consequences_hash !== c.hash)
    return { state: "stale", message_ru: DESTRUCTIVE_RU.stale, changeId: null, archiveTag: null };
  return { state: "confirmed", message_ru: null, changeId: row.id, archiveTag: row.archive_tag };
}

/** confirmDestructive: owner only (the route checks the role); the hash must match the consequences counted now. */
export async function confirmDestructive(
  db: Db,
  pg: postgres.Sql,
  sys: System,
  a: { userId: string; revision: number; hash: string; spec: AppSpec },
): Promise<{ row: DestructiveRow; consequences: Consequences }> {
  const c = await computeConsequences(db, pg, sys, a.revision, a.spec);
  if (!c.required) throw invalid(DESTRUCTIVE_RU.nothing);
  if (c.hash !== a.hash)
    throw new ApiError("DESTRUCTIVE_CONSEQUENCES_CHANGED", DESTRUCTIVE_RU.changed, { consequences: c });
  if (c.blocking)
    throw new ApiError(
      "DESTRUCTIVE_BLOCKED",
      c.changes.find((x) => x.blocking)?.text_ru ?? DESTRUCTIVE_RU.missing,
      { consequences: c },
    );
  const row = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("platform.destructive_changes")
      .set({ status: "superseded" })
      .where("system_id", "=", sys.id)
      .where("status", "=", "confirmed")
      .execute();
    return trx
      .insertInto("platform.destructive_changes")
      .values({
        system_id: sys.id,
        revision: a.revision,
        base_revision: c.baseRevision,
        consequences_hash: c.hash as string,
        consequences: json(c.changes),
        status: "confirmed",
        confirmed_by: a.userId,
        archive_tag: `c${randomBytes(6).toString("hex")}`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  return { row, consequences: c };
}

export function archiveSchemaOf(sys: Pick<System, "schema_key">): string {
  return archiveSchemaName(schemaName(sys.schema_key, "prod"));
}

/** Marks the confirmation applied inside the migration transaction (journal: publication, archive tables). */
export async function markApplied(
  tx: postgres.TransactionSql,
  a: {
    changeId: string;
    publicationId: string;
    baseRevision: number | null;
    schema: string;
    tables: string[];
  },
): Promise<void> {
  const res = await tx`
    update platform.destructive_changes
       set status = 'applied', applied_at = now(), publication_id = ${a.publicationId},
           base_revision = ${a.baseRevision}, archive_schema = ${a.schema},
           archive_tables = cast(${JSON.stringify(a.tables)} as jsonb)
     where id = ${a.changeId} and status = 'confirmed'`;
  // The confirmation was superseded or applied by another publication meanwhile: the migration transaction rolls back.
  if (res.count !== 1) throw new RunFailure("DESTRUCTIVE_IN_PROD", DESTRUCTIVE_RU.notApplicable);
}

/** The change «Отменить правку» would undo: the newest applied one whose schema is still the current prod schema. */
export interface UndoTarget {
  row: DestructiveRow;
  /** Revision prod goes back to (the publication live before the change). */
  toRevision: number;
  toBundleKey: string;
  baseRevision: number;
}

export async function undoTarget(db: Db, sys: System): Promise<UndoTarget | null> {
  const row = await db
    .selectFrom("platform.destructive_changes")
    .selectAll()
    .where("system_id", "=", sys.id)
    .where("status", "=", "applied")
    .orderBy("applied_at", "desc")
    .executeTakeFirst();
  if (!row || row.publication_id === null || row.base_revision === null) return null;
  if (sys.schema_hwm_revision !== row.revision) return null;
  const prev = await db
    .selectFrom("platform.publications as p")
    .innerJoin("platform.publications as q", "q.id", "p.prev_publication_id")
    .select(["q.revision", "q.bundle_key"])
    .where("p.id", "=", row.publication_id)
    .executeTakeFirst();
  if (!prev) return null;
  return { row, toRevision: prev.revision, toBundleKey: prev.bundle_key, baseRevision: row.base_revision };
}

/** Journal of the system (api.yaml#listDestructiveChanges): newest first. */
export async function listChanges(db: Db, systemId: string, limit = 50): Promise<DestructiveRow[]> {
  return db
    .selectFrom("platform.destructive_changes")
    .selectAll()
    .where("system_id", "=", systemId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

/** An applied change newer than `revision` blocks a plain prod rollback to it (old code needs the archived data). */
export async function rollbackBlockedBy(
  db: Db,
  systemId: string,
  revision: number,
): Promise<DestructiveRow | undefined> {
  return db
    .selectFrom("platform.destructive_changes")
    .selectAll()
    .where("system_id", "=", systemId)
    .where("status", "=", "applied")
    .where("revision", ">", revision)
    .executeTakeFirst();
}

/** api.yaml#/components/schemas/DestructiveChangeRecord */
export function toRecord(r: DestructiveRow, undoableId: string | null) {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    id: r.id,
    revision: r.revision,
    baseRevision: r.base_revision,
    status: r.status,
    consequences: r.consequences as Consequence[],
    confirmedBy: r.confirmed_by,
    confirmedAt: new Date(r.confirmed_at).toISOString(),
    appliedAt: iso(r.applied_at),
    undoneBy: r.undone_by,
    undoneAt: iso(r.undone_at),
    undoRunId: r.undo_run_id,
    undoable: r.id === undoableId,
  };
}
