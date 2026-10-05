// M2-72 (product.yaml#decisions.D56_destructive_changes, D72; db.yaml#destructive_changes): owner confirmations of prod
// changes that remove or narrow data, bound to the revision and the hash of the consequences list; the same row is the
// journal — applied (archive tag and tables), undone (who, when, which run). Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.destructive_changes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES platform.systems(id),
    revision integer NOT NULL,
    base_revision integer,
    consequences_hash text NOT NULL,
    consequences jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('confirmed','superseded','applied','undone')),
    confirmed_by uuid NOT NULL REFERENCES platform.users(id),
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    archive_tag text NOT NULL,
    archive_schema text,
    archive_tables jsonb NOT NULL DEFAULT '[]'::jsonb,
    publication_id uuid REFERENCES platform.publications(id),
    applied_at timestamptz,
    undone_by uuid REFERENCES platform.users(id),
    undone_at timestamptz,
    undo_run_id uuid REFERENCES platform.runs(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (system_id, revision) REFERENCES platform.revisions (system_id, version) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS destructive_changes_system_idx
    ON platform.destructive_changes (system_id, created_at DESC)`.execute(db);
}
