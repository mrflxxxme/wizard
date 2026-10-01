// M2-07: platform.payment_methods, platform.payments, platform.subscriptions (specs/platform/db.yaml,
// specs/platform/billing.yaml#card_binding, #recurring). Columns beyond db.yaml — docs/reviews/impl-notes/M2-07.md:
// payment_methods.card_fingerprint (L3-28 «one card in ≤ 3 orgs»), payments.meta (plan, period, client IP hash,
// rejection code). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.payment_methods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs,
    provider text NOT NULL DEFAULT 'yookassa',
    provider_method_id text NOT NULL,
    card_last4 text NOT NULL,
    card_type text,
    issuer_country text NOT NULL CHECK (issuer_country ~ '^[A-Z]{2}$'),
    card_fingerprint text NOT NULL,
    bound_by uuid NOT NULL REFERENCES platform.users,
    bound_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX payment_methods_provider_method_key ON platform.payment_methods (provider, provider_method_id)`,
  `CREATE INDEX payment_methods_org_active_idx ON platform.payment_methods (org_id) WHERE revoked_at IS NULL`,
  `CREATE INDEX payment_methods_fingerprint_idx ON platform.payment_methods (card_fingerprint)`,
  `CREATE TABLE platform.payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs,
    kind text NOT NULL CHECK (kind IN ('card_binding','subscription','topup')),
    amount_kop bigint NOT NULL CHECK (amount_kop > 0),
    status text NOT NULL CHECK (status IN ('pending','waiting_for_capture','succeeded','canceled','refunded')),
    provider_payment_id text,
    idempotence_key text NOT NULL,
    packs integer,
    settled_at timestamptz,
    meta jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX payments_provider_payment_key ON platform.payments (provider_payment_id)`,
  `CREATE UNIQUE INDEX payments_idempotence_key ON platform.payments (idempotence_key)`,
  `CREATE INDEX payments_org_kind_created_idx ON platform.payments (org_id, kind, created_at DESC)`,
  `CREATE TABLE platform.subscriptions (
    org_id uuid PRIMARY KEY REFERENCES platform.orgs,
    plan text NOT NULL CHECK (plan IN ('start','business')),
    status text NOT NULL CHECK (status IN ('active','past_due','cancelled')),
    payment_method_id uuid REFERENCES platform.payment_methods,
    current_period_start timestamptz NOT NULL,
    current_period_end timestamptz NOT NULL,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    next_charge_at timestamptz,
    failed_attempts smallint NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX subscriptions_next_charge_idx ON platform.subscriptions (next_charge_at) WHERE next_charge_at IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
