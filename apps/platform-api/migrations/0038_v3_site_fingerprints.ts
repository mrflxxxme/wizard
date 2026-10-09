// Memory of the template gate (V3-14; specs/agents/builder-v3.md §3 C6 stage template_gate, product.yaml D77_v3 (6)):
// the latest fingerprint of each system's public site — the section structure of the site model, DOM shapes and
// perceptual hashes of screenshots, no texts and no images — with its niche and archetype. A new v3 build is compared
// with the recent sites of its niche and of its organisation. One row per system; deleted with the system.
// Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.system_site_fingerprints (
    system_id uuid PRIMARY KEY REFERENCES platform.systems(id) ON DELETE CASCADE,
    niche text NOT NULL CHECK (length(niche) BETWEEN 1 AND 200),
    archetype text NOT NULL CHECK (archetype ~ '^[a-z][a-z0-9_]{0,39}$'),
    fingerprint jsonb NOT NULL CHECK (jsonb_typeof(fingerprint) = 'object'),
    similarity numeric(4,3) CHECK (similarity BETWEEN 0 AND 1),
    run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS system_site_fingerprints_niche_idx
    ON platform.system_site_fingerprints (niche, updated_at DESC)`.execute(db);
}
