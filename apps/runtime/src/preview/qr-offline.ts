// QrOfflineStore over Postgres (connectors/qr.yaml#offline): bulk reads of the carrier and check-in tables,
// revoked hashes from _w_connector_calls (ctx.store keys), _w_qr_events and _w_qr_devices of the system schema.
import { QR_REVOKED_PREFIX, type QrConfig, type QrOfflineStore, type QrSyncResult } from "@wizard/connectors";
import { type DataAccess, SYSTEM_SUBJECT } from "../data/access.js";

export function pgQrOfflineStore(
  data: DataAccess,
  integration: string,
  config: QrConfig,
  now: () => Date,
): QrOfflineStore {
  const run = <T>(fn: (sql: import("postgres").TransactionSql) => Promise<T>) =>
    data.transaction("default", SYSTEM_SUBJECT, (tx) => fn(tx.sql));
  const s = data.schema;
  const columns = [...new Set(["id", "status", config.tokenField, ...(config.displayFields ?? [])])];
  const revokedPrefix = `kv:${integration}:${QR_REVOKED_PREFIX}`;
  return {
    carriers: (since) =>
      run(async (sql) => {
        const rows = await sql`
          select ${sql(columns)} from ${sql(s)}.${sql(config.entity)} as t
          where ${since === null ? sql`true` : sql`coalesce(t.updated_at, t.created_at) > ${since}`}
          order by t.id`;
        return rows.map((r) => ({ ...r, id: String(r.id) }));
      }),
    checkedInTokens: (since) =>
      run(async (sql) => {
        const rows = await sql`
          select t.${sql(config.tokenField)} as token
          from ${sql(s)}.${sql(config.checkin.entity)} as c
          join ${sql(s)}.${sql(config.entity)} as t on t.id = c.${sql(config.checkin.refField)}
          where ${since === null ? sql`true` : sql`c.created_at > ${since}`}`;
        return rows.map((r) => r.token).filter((t): t is string => typeof t === "string");
      }),
    revokedHashes: (since) =>
      run(async (sql) => {
        const rows = await sql`
          select k.idempotency_key as key from ${sql(s)}.${sql("_w_connector_calls")} as k
          where starts_with(k.idempotency_key, ${revokedPrefix})
            and (k.result ->> 'until')::bigint >= ${now().getTime()}
            and ${since === null ? sql`true` : sql`k.created_at > ${since}`}`;
        return rows.map((r) => String(r.key).slice(revokedPrefix.length));
      }),
    events: (ids) =>
      ids.length === 0
        ? Promise.resolve(new Map())
        : run(async (sql) => {
            const rows = await sql`
              select e.client_event_id as id, e.result from ${sql(s)}.${sql("_w_qr_events")} as e
              where e.client_event_id = any(${sql.array([...ids])}) and e.integration = ${integration}`;
            return new Map(rows.map((r) => [String(r.id), r.result as QrSyncResult]));
          }),
    saveEvent: (e) =>
      run(async (sql) => {
        const inserted = await sql`
          insert into ${sql(s)}.${sql("_w_qr_events")}
            (client_event_id, device_id, integration, result, clock_skew, received_at)
          values (${e.clientEventId}, ${e.deviceId}, ${integration}, ${e.result}, ${e.clockSkew}, ${e.receivedAt})
          on conflict (client_event_id) do nothing
          returning result`;
        if (inserted[0]) return inserted[0].result as QrSyncResult;
        const rows = await sql`
          select e.result from ${sql(s)}.${sql("_w_qr_events")} as e where e.client_event_id = ${e.clientEventId}`;
        return (rows[0]?.result as QrSyncResult | undefined) ?? e.result;
      }),
    saveDevice: (d) =>
      run(async (sql) => {
        await sql`
          insert into ${sql(s)}.${sql("_w_qr_devices")} (device_id, user_id, last_sync_at, pending)
          values (${d.deviceId}, ${d.userId}, ${d.lastSyncAt}, ${d.pending})
          on conflict (device_id) do update
            set user_id = excluded.user_id, last_sync_at = excluded.last_sync_at, pending = excluded.pending`;
      }),
    purgeEvents: (before) =>
      run(async (sql) => {
        await sql`delete from ${sql(s)}.${sql("_w_qr_events")} where received_at < ${before}`;
      }),
  };
}
