// Database roles of runtime.yaml#postgres.roles in every environment, not only on the dev stand: wizard_owner runs the
// draft/prod migrations of systems (agents/draft.ts MIGRATOR_ROLE), wizard_runtime serves their data without
// BYPASSRLS. scripts/db.mjs `roles` made them for dev and CI only, so the pilot's own PostgreSQL had none and every
// build failed with MIGRATION_FAILED (42704, role "wizard_runtime" does not exist) — found by the local rehearsal of
// the pilot (docs/ops/local-rehearsal.md). Forward-only.
// * Roles are cluster-wide while the migrator's lock is per database: parallel test databases (CI) race on CREATE
//   ROLE, so a duplicate is not an error (the same pattern as appspec toSystemRoleDDL).
// * A non-superuser login with CREATEROLE (managed PostgreSQL 16) gets no SET on the roles it creates
//   (createrole_self_grant is empty): the platform's `SET LOCAL ROLE` would fail with 42501 — grant it explicitly.
// * An existing role with SUPERUSER or BYPASSRLS, or an owner role without CREATE, stops the migration loudly: RLS of
//   every system depends on them.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$
  DECLARE
    r text;
  BEGIN
    FOREACH r IN ARRAY ARRAY['wizard_owner', 'wizard_runtime'] LOOP
      BEGIN
        EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
      END;
      IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'role % must be NOSUPERUSER NOBYPASSRLS (runtime.yaml#postgres.roles)', r;
      END IF;
      IF NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user)
         AND NOT pg_catalog.pg_has_role(session_user, r, 'SET') THEN
        EXECUTE pg_catalog.format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', r, session_user);
      END IF;
    END LOOP;
    EXECUTE pg_catalog.format('GRANT CREATE ON DATABASE %I TO wizard_owner', pg_catalog.current_database());
    IF NOT pg_catalog.has_database_privilege('wizard_owner', pg_catalog.current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'wizard_owner has no CREATE on database % (the login must own it)', pg_catalog.current_database();
    END IF;
  END $$`.execute(db);
}
