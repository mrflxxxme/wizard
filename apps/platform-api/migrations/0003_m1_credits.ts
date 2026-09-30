// M1-03: platform.credit_ledger (append-only) and view platform.credit_buckets (specs/platform/db.yaml,
// specs/platform/billing.yaml#ledger). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.credit_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES platform.orgs,
    kind text NOT NULL CHECK (kind IN ('grant','charge','hold','release','expire','refund','adjustment')),
    amount_milli bigint NOT NULL,
    bucket text CHECK (bucket IN ('free_welcome','free_monthly','plan_monthly','topup','adjustment')),
    bucket_expires_at timestamptz,
    run_id uuid REFERENCES platform.runs,
    system_id uuid,
    payment_id uuid,
    idempotency_key text NOT NULL,
    note_ru text,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT credit_ledger_sign_check CHECK (
      (kind IN ('grant','release','refund') AND amount_milli > 0)
      OR (kind IN ('charge','hold','expire') AND amount_milli < 0)
      OR (kind = 'adjustment' AND amount_milli <> 0)
    )
  )`,
  `CREATE UNIQUE INDEX credit_ledger_org_idem_key ON platform.credit_ledger (org_id, idempotency_key)`,
  `CREATE INDEX credit_ledger_org_created_idx ON platform.credit_ledger (org_id, created_at DESC)`,
  `CREATE INDEX credit_ledger_run_idx ON platform.credit_ledger (run_id)`,
  `CREATE FUNCTION platform.credit_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'platform.credit_ledger is append-only (% denied)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END $$`,
  `CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE OR DELETE ON platform.credit_ledger
    FOR EACH ROW EXECUTE FUNCTION platform.credit_ledger_append_only()`,
  `CREATE TRIGGER credit_ledger_no_truncate BEFORE TRUNCATE ON platform.credit_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION platform.credit_ledger_append_only()`,
  // Every ledger row carries its bucket (a hold/charge spread over buckets is one row per bucket), so the
  // remainder of a bucket is a plain sum.
  `CREATE VIEW platform.credit_buckets AS
    SELECT org_id, bucket, bucket_expires_at, sum(amount_milli)::bigint AS remaining_milli
    FROM platform.credit_ledger
    GROUP BY org_id, bucket, bucket_expires_at`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
