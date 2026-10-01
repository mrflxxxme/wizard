// M2 cleanup after M2-08/M2-09/M2-15 (docs/reviews/impl-notes/cleanup-2026-10-01.md): partial index on
// runs(finished_at) for the «run failed rate > 20% за 1 ч» alert and its gauge (ops/metrics.ts runFailureWindow), index
// on llm_calls(created_at) for the platform LLM cap of the month (billing/llm-cap.ts llmSpentRub), and the deployments
// view with the org-wide suspension (abuse.yaml#takedown.flow «orgs.suspended_at: все системы организации снимаются»):
// runtime answers 451 for every system of a suspended org. Forward-only.
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
  `CREATE INDEX IF NOT EXISTS runs_finished_at_idx ON platform.runs (finished_at) WHERE finished_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS llm_calls_created_at_idx ON platform.llm_calls (created_at)`,
  `CREATE OR REPLACE VIEW platform.deployments AS
    SELECT ${cols("'draft'", "r.bundle_key", "r.created_at", "(s.suspended_at IS NOT NULL OR o.suspended_at IS NOT NULL)")}
      FROM platform.systems s
      JOIN platform.orgs o ON o.id = s.org_id
      JOIN platform.revisions r ON r.system_id = s.id AND r.version = s.preview_revision
     WHERE s.preview_revision IS NOT NULL AND s.deleted_at IS NULL
    UNION ALL
    SELECT ${cols("'prod'", "p.bundle_key", "p.live_at", "(s.suspended_at IS NOT NULL OR o.suspended_at IS NOT NULL OR p.status = 'suspended')")}
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
