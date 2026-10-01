// M1-01 (after 0006_m2_exports): platform.secrets_refs (specs/platform/db.yaml) — secrets entered at needs_input kind=secret are stored by
// the HTTP handler; runs see only secret://name (workflows.yaml#execution.M1.dbos_data). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.secrets_refs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs,
    system_id uuid NOT NULL REFERENCES platform.systems ON DELETE CASCADE,
    env text NOT NULL CHECK (env IN ('draft','prod')),
    name text NOT NULL CHECK (name ~ '^[a-z0-9_]+$'),
    backend text NOT NULL CHECK (backend IN ('local_encrypted','openbao')),
    backend_path text NOT NULL,
    created_by uuid REFERENCES platform.users,
    rotated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX secrets_refs_system_env_name_key ON platform.secrets_refs (system_id, env, name)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
