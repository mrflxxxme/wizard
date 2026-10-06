// Kind of an organization (B2-01, B2-04; product.yaml#decisions.D76_beta_v2 (10), docs/reviews/grill-6.md № 12, 18):
// client — a customer; staff — the founder's own orgs (no D70 pilot limit, the staff reserve of the daily LLM cap);
// eval — probes and measurements (own daily LLM cap, the B2 development budget). The purpose of an llm_call is the kind
// of its org (billing/llm-spend.ts). Backfill: orgs owned by a staff user → staff; the measurement orgs of
// tools/eval/server/seed.mjs («Замер D67 · <runid>») → eval. 0031: 0020–0030 are reserved (milestones.yaml M2P
// merge_rules) and the migrator keeps the order. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.orgs
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'client' CHECK (kind IN ('client', 'staff', 'eval'))`.execute(
    db,
  );
  await sql`UPDATE platform.orgs o SET kind = 'staff'
    WHERE o.kind = 'client'
      AND EXISTS (SELECT 1 FROM platform.memberships m
                    JOIN platform.users u ON u.id = m.user_id
                   WHERE m.org_id = o.id AND m.role = 'owner' AND u.is_staff AND u.deleted_at IS NULL)`.execute(
    db,
  );
  await sql`UPDATE platform.orgs o SET kind = 'eval' WHERE o.name LIKE 'Замер D67 · %'`.execute(db);
}
