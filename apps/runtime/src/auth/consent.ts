// Withdrawal of consent (runtime.yaml#auth.consent_at_login, security/compliance.yaml#system_package.consent.withdrawal;
// L3-33): sessions are revoked, the login is blocked and the user's data is anonymized at once — the users row and
// pii fields of rows where the user is the ownerField. A row that cannot be anonymized (constraints) is reported as
// pending in _w_audit for the retention pass.
import { type Entity, type Field, quoteIdent } from "@wizard/appspec";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { LoadedSystem } from "../system.js";

const piiOf = (e: Entity): Field[] =>
  e.fields.filter((f) => (f.pii ?? (f.type === "file" ? "basic" : "none")) !== "none");

/** Placeholder for NOT NULL pii columns that satisfies the format checks of appspec (FORMAT_RE). */
function placeholder(f: Field): string | null {
  switch (f.type) {
    case "string":
    case "text":
      return "Удалено";
    case "email":
      return "deleted@anonymized.invalid";
    case "phone":
      return "+70000000000";
    default:
      return null;
  }
}

export interface RevokeResult {
  entities: { entity: string; rows: number }[];
  pending: string[];
}

export async function revokeConsent(sys: LoadedSystem, userId: string): Promise<RevokeResult> {
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const s = sys.schema;
    const T = (name: string) => `${quoteIdent(s)}.${quoteIdent(name)}`;
    const out: RevokeResult = { entities: [], pending: [] };
    await tx.sql.unsafe(`delete from ${T("_w_sessions")} where user_id = $1`, [userId]);
    await tx.sql.unsafe(
      `update ${T("users")} set email = null, phone = null, telegram_id = null, telegram_chat_id = null,
         display_name = null, attrs = '{}'::jsonb, blocked_at = coalesce(blocked_at, now())
       where id = $1`,
      [userId],
    );
    await tx.sql.unsafe(`delete from ${T("_w_telegram_links")} where user_id = $1`, [userId]);
    for (const e of sys.spec.entities) {
      if (!e.ownerField) continue;
      const pii = piiOf(e);
      if (pii.length === 0) continue;
      const cols = await tx.sql.unsafe<{ column_name: string; is_nullable: string }[]>(
        `select column_name, is_nullable from information_schema.columns
         where table_schema = $1 and table_name = $2`,
        [s, e.name],
      );
      const nullable = new Map(cols.map((c) => [c.column_name, c.is_nullable === "YES"]));
      const sets: string[] = [];
      const params: unknown[] = [userId];
      for (const f of pii) {
        if (!nullable.has(f.name)) continue;
        if (nullable.get(f.name)) sets.push(`${quoteIdent(f.name)} = null`);
        else {
          const v = placeholder(f);
          if (v === null) continue;
          params.push(v);
          sets.push(`${quoteIdent(f.name)} = $${params.length}`);
        }
      }
      if (sets.length === 0) continue;
      try {
        const res = await tx.sql.savepoint((sp) =>
          sp.unsafe(
            `update ${T(e.name)} set ${sets.join(", ")} where ${quoteIdent(e.ownerField as string)} = $1`,
            params as never[],
          ),
        );
        out.entities.push({ entity: e.name, rows: res.count });
      } catch {
        out.pending.push(e.name);
      }
    }
    await tx.sql.unsafe(
      `insert into ${T("_w_audit")} (actor_user_id, role, entity, record_id, op, fields)
       values ($1, '__system', 'users', $1, $2, string_to_array($3::text, ','))`,
      [userId, out.pending.length ? "consent_revoked_pending" : "consent_revoked", out.pending.join(",")],
    );
    return out;
  });
}
