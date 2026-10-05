// System tables of schemas created before a newer runtime (runtime.yaml#postgres.system_tables): create_schema uses
// CREATE TABLE IF NOT EXISTS, so tables and columns added later (M2-05: users.last_login_at, _w_deletion_log) are
// missing in older app_<key>_<env>. The draft migration and publish run these statements before the plan's DDL;
// toRLS of the plan then enables RLS and grants on the new tables.
import { quoteIdent, SYSTEM_TABLES, systemIndexDDL } from "@wizard/appspec";

const COLUMN_NAME = /^"([a-z_][a-z0-9_]*)"\s/;
/** Column constraints that cannot be added to an existing table by ADD COLUMN IF NOT EXISTS safely. */
const KEY_COLUMN = /\bPRIMARY KEY\b|\bGENERATED\b/;

/**
 * Idempotent upgrade of an existing system schema to SYSTEM_TABLES: missing tables are created, missing nullable or
 * defaulted columns and SYSTEM_INDEXES are added. Run as the schema owner (migrator role) in the migration transaction.
 */
export function upgradeSystemTables(schema: string): string[] {
  const s = quoteIdent(schema);
  const out = ["SET LOCAL lock_timeout = '3s'"];
  for (const [table, cols] of Object.entries(SYSTEM_TABLES)) {
    const t = `${s}.${quoteIdent(table)}`;
    out.push(`CREATE TABLE IF NOT EXISTS ${t} (\n  ${cols.join(",\n  ")}\n)`);
    for (const col of cols) {
      if (!COLUMN_NAME.test(col) || KEY_COLUMN.test(col)) continue;
      // A NOT NULL column without a default cannot be added to a table with rows; none exists so far.
      if (/\bNOT NULL\b/.test(col) && !/\bDEFAULT\b/.test(col)) continue;
      out.push(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${col}`);
    }
  }
  out.push(...systemIndexDDL(schema));
  return out;
}
