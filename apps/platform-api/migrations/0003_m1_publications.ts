// M1-04: platform.publications (db.yaml#tables.publications) and the prod rows of the deployments view. Forward-only.
import { type Kysely, sql } from "kysely";

const DEPLOYMENT_COLUMNS = `s.schema_key AS system_id,
           s.slug,
           %ENV%::text AS env,
           r.version AS revision,
           encode(sha256(convert_to(r.spec::text, 'UTF8')), 'hex') AS spec_hash,
           %BUNDLE% AS bundle_key,
           %PUBLISHED% AS published_at,
           %SUSPENDED% AS suspended,
           jsonb_build_object('phoneOtp', o.plan IN ('start','business')) AS features`;

const cols = (env: string, bundle: string, published: string, suspended: string) =>
  DEPLOYMENT_COLUMNS.replace("%ENV%", env)
    .replace("%BUNDLE%", bundle)
    .replace("%PUBLISHED%", published)
    .replace("%SUSPENDED%", suspended);

const STATEMENTS = [
  `CREATE TABLE platform.publications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES platform.systems,
    env text NOT NULL DEFAULT 'prod' CHECK (env = 'prod'),
    revision integer NOT NULL,
    schema_revision integer NOT NULL,
    prev_publication_id uuid REFERENCES platform.publications,
    migration_plan jsonb NOT NULL,
    bundle_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('planned','applying','live','superseded','failed','suspended')),
    run_id uuid REFERENCES platform.runs,
    created_by uuid NOT NULL REFERENCES platform.users,
    live_at timestamptz,
    suspended_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (system_id, revision) REFERENCES platform.revisions (system_id, version)
  )`,
  `CREATE UNIQUE INDEX publications_live_idx ON platform.publications (system_id) WHERE status = 'live'`,
  `CREATE INDEX publications_system_created_idx ON platform.publications (system_id, created_at DESC)`,
  `CREATE OR REPLACE VIEW platform.deployments AS
    SELECT ${cols("'draft'", "r.bundle_key", "r.created_at", "(s.suspended_at IS NOT NULL)")}
      FROM platform.systems s
      JOIN platform.orgs o ON o.id = s.org_id
      JOIN platform.revisions r ON r.system_id = s.id AND r.version = s.preview_revision
     WHERE s.preview_revision IS NOT NULL AND s.deleted_at IS NULL
    UNION ALL
    SELECT ${cols("'prod'", "p.bundle_key", "p.live_at", "(s.suspended_at IS NOT NULL OR p.status = 'suspended')")}
      FROM platform.publications p
      JOIN platform.systems s ON s.id = p.system_id
      JOIN platform.orgs o ON o.id = s.org_id
      JOIN platform.revisions r ON r.system_id = p.system_id AND r.version = p.revision
     WHERE p.status IN ('live','suspended') AND s.deleted_at IS NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
