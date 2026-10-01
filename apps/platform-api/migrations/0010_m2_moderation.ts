// M2-04 follow-up (G2 at prod publication): platform.founder_reviews and platform.brand_allowlist
// (db.yaml#tables.founder_reviews, #brand_allowlist; security/abuse.yaml#scoring.effect, #patterns.brands.override).
// A G2-AF-08/G2-AF-09 warning puts the revision on review before prod; staff decides (api.yaml#adminFounderReview).
// Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.founder_reviews (
    system_id uuid NOT NULL REFERENCES platform.systems,
    revision integer NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','approved','rejected')),
    reviewer uuid REFERENCES platform.users,
    note text,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, revision)
  )`,
  `CREATE INDEX founder_reviews_pending_idx ON platform.founder_reviews (created_at) WHERE status = 'pending'`,
  `CREATE TABLE platform.brand_allowlist (
    org_id uuid NOT NULL REFERENCES platform.orgs,
    brand_id text NOT NULL,
    verified_by uuid NOT NULL REFERENCES platform.users,
    evidence_note text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, brand_id)
  )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
