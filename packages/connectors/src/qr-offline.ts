// QR offline package and sync (specs/connectors/qr.yaml#offline, #endpoints.manifest/sync; M2-03).
// The package carries only h = qrTokenHash(rand), the row id, a display line and the status: no token, key or PII.
import { createHash } from "node:crypto";
import { z } from "zod";
import { UniqueViolation } from "./errors.js";
import { display, type QrConfig } from "./qr.js";
import { parseQrPayload, qrTokenHash } from "./qr-token.js";
import { entityOf, fieldOf } from "./spec-util.js";
import type { ConnectorCtx, Row } from "./types.js";

/** Lifetime of a device copy without a refresh (qr.yaml#offline.package.storage: 72 h from issue). */
export const QR_MANIFEST_TTL_MS = 72 * 60 * 60_000;
export const QR_SYNC_MAX_EVENTS = 500;
/** _w_qr_events keep results for idempotent re-sends (qr.yaml#offline.sync_protocol). */
export const QR_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const QR_CLOCK_SKEW_MS = 10 * 60_000;
/** A delta re-reads this much before its cursor, so rows of transactions that committed late are not lost. */
const CURSOR_OVERLAP_MS = 60_000;

export interface QrManifestEntry {
  /** base64url(sha256(rand))[0:22]. */
  h: string;
  id: string;
  /** Display line: displayFields joined with « · » (pii=none, G2). */
  d: string;
  /** Carrier status. */
  s: string;
}

export interface QrManifest {
  manifestId: string;
  cursor: string;
  generatedAt: string;
  expiresAt: string;
  /** true — entries replace the device copy; false — a delta since the requested cursor. */
  full: boolean;
  /** Statuses that let the holder in (config.validStatuses); the device rejects other `s` values. */
  validStatuses: string[];
  entries: QrManifestEntry[];
  /** Hashes of tickets already checked in (online or by other devices). */
  checkedIn: string[];
  /** Hashes of revoked tokens. */
  revoked: string[];
}

export type QrSyncResult = "accepted" | "duplicate" | "unknown" | "revoked";

export interface QrSyncEvent {
  clientEventId: string;
  h: string;
  /** Device clock. */
  scannedAt: string;
  gate?: string;
  localResult?: string;
}

export interface QrSyncInput {
  deviceId: string;
  /** users.id of the scanner (for _w_qr_devices). */
  userId: string | null;
  events: QrSyncEvent[];
  /** Device clock at sending: a difference with the server over 10 min sets clock_skew. */
  sentAt?: string;
  /** Events left in the device queue after this batch. */
  pending?: number;
}

export interface QrSyncResponse {
  results: { clientEventId: string; result: QrSyncResult; firstScannedAt?: string }[];
  accepted: number;
  duplicate: number;
  unknown: number;
  revoked: number;
  /** Server position after this batch (manifest cursor format). */
  cursor: string;
}

/** Host storage behind the offline endpoints: bulk reads of the system schema, _w_qr_events, _w_qr_devices. */
export interface QrOfflineStore {
  /** Carrier rows created or updated after `since`; every row when null. */
  carriers(since: Date | null): Promise<Row[]>;
  /** tokenField values of carriers with a check-in created after `since` (every check-in when null). */
  checkedInTokens(since: Date | null): Promise<string[]>;
  /** Hashes stored under ctx.store keys QR_REVOKED_PREFIX + h after `since` (still within their TTL). */
  revokedHashes(since: Date | null): Promise<string[]>;
  /** Stored results of already processed events. */
  events(ids: readonly string[]): Promise<Map<string, QrSyncResult>>;
  /** Stores the result once (the first write wins) and returns the stored one. */
  saveEvent(e: {
    clientEventId: string;
    deviceId: string;
    result: QrSyncResult;
    clockSkew: boolean;
    receivedAt: Date;
  }): Promise<QrSyncResult>;
  saveDevice(d: {
    deviceId: string;
    userId: string | null;
    pending: number;
    lastSyncAt: Date;
  }): Promise<void>;
  /** Drops _w_qr_events received before `before`. */
  purgeEvents(before: Date): Promise<void>;
}

export type QrOfflineDenied = { forbidden: true; reason: "role" | "offline_disabled" };

function denied(config: QrConfig, role: string): QrOfflineDenied | null {
  if (!config.scannerRoles.includes(role)) return { forbidden: true, reason: "role" };
  if (config.offline !== true) return { forbidden: true, reason: "offline_disabled" };
  return null;
}

export function encodeQrCursor(at: Date): string {
  return Buffer.from(JSON.stringify({ v: 1, t: at.getTime() })).toString("base64url");
}

/** Cursor → its time; null for anything malformed. */
export function decodeQrCursor(cursor: string | undefined | null): Date | null {
  if (!cursor || cursor.length > 200) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; t?: unknown };
    return v.v === 1 && typeof v.t === "number" && Number.isFinite(v.t) ? new Date(v.t) : null;
  } catch {
    return null;
  }
}

/** h of a stored token value; null when the value is not a WZ1 payload. */
export function qrOfflineHash(token: unknown): string | null {
  const parsed = typeof token === "string" ? parseQrPayload(token) : null;
  return parsed ? qrTokenHash(parsed.rand) : null;
}

/** Stable per system, env and integration: the device keeps one copy per manifestId. */
export function qrManifestId(ctx: ConnectorCtx): string {
  return createHash("sha256")
    .update(`${ctx.system.id}|${ctx.system.env}|${ctx.integration.name}`)
    .digest("base64url")
    .slice(0, 16);
}

/** GET /_wizard/qr/manifest?since=<cursor> (qr.yaml#endpoints.manifest, #offline.package). */
export async function qrManifest(
  ctx: ConnectorCtx,
  role: string,
  store: QrOfflineStore,
  input: { since?: string | null },
): Promise<QrOfflineDenied | { forbidden: false; body: QrManifest }> {
  const config = ctx.integration.config as QrConfig;
  const no = denied(config, role);
  if (no) return no;
  const now = ctx.now();
  const since = decodeQrCursor(input.since);
  const delta = since !== null && since <= now && now.getTime() - since.getTime() < QR_MANIFEST_TTL_MS;
  const from = delta ? new Date(since.getTime() - CURSOR_OVERLAP_MS) : null;

  const labels = new Map<string, Promise<string>>();
  const entries: QrManifestEntry[] = [];
  for (const row of await store.carriers(from)) {
    const h = qrOfflineHash(row[config.tokenField]);
    if (!h) continue;
    const shown = await display(ctx, config, row, labels);
    entries.push({
      h,
      id: row.id,
      d: [shown.ticketTitle, shown.details].filter(Boolean).join(" · "),
      s: String(row.status ?? ""),
    });
  }
  const checkedIn = (await store.checkedInTokens(from))
    .map(qrOfflineHash)
    .filter((h): h is string => h !== null);
  return {
    forbidden: false,
    body: {
      manifestId: qrManifestId(ctx),
      cursor: encodeQrCursor(now),
      generatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + QR_MANIFEST_TTL_MS).toISOString(),
      full: !delta,
      validStatuses: [...config.validStatuses],
      entries,
      checkedIn: [...new Set(checkedIn)],
      revoked: [...new Set(await store.revokedHashes(from))],
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoTime = z.iso.datetime({ offset: true });

const syncBodySchema = z.strictObject({
  deviceId: z.string().min(1).max(64),
  events: z
    .array(
      z.strictObject({
        clientEventId: z.string().regex(UUID_RE),
        h: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
        scannedAt: isoTime,
        gate: z.string().min(1).max(100).optional(),
        localResult: z.string().max(20).optional(),
      }),
    )
    .max(QR_SYNC_MAX_EVENTS),
  sentAt: isoTime.optional(),
  pending: z.number().int().min(0).max(1_000_000).optional(),
});

export type QrSyncBody = z.infer<typeof syncBodySchema>;

/** Body of POST /_wizard/qr/sync; `fields` name the bad parts for a 422 VALIDATION_FAILED. */
export function parseQrSyncBody(
  body: unknown,
): { ok: true; value: QrSyncBody } | { ok: false; fields: { field: string; message: string }[] } {
  const r = syncBodySchema.safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    fields: r.error.issues.slice(0, 20).map((i) => ({
      field: i.path.join(".") || "body",
      message:
        i.path[0] === "events" && i.code === "too_big"
          ? `Не больше ${QR_SYNC_MAX_EVENTS} отметок за раз`
          : "Неверное значение",
    })),
  };
}

/**
 * POST /_wizard/qr/sync (qr.yaml#offline.sync_protocol): idempotent by clientEventId, the first check-in wins,
 * later ones are `duplicate` and move checkin.scanned_at to the earliest scan.
 */
export async function qrSync(
  ctx: ConnectorCtx,
  role: string,
  store: QrOfflineStore,
  input: QrSyncInput,
): Promise<QrOfflineDenied | { forbidden: false; body: QrSyncResponse }> {
  const config = ctx.integration.config as QrConfig;
  const no = denied(config, role);
  if (no) return no;
  const now = ctx.now();
  const sentAt = input.sentAt ? Date.parse(input.sentAt) : Number.NaN;
  const checkinEntity = entityOf(ctx.system.spec, config.checkin.entity);
  const existing = await store.events(input.events.map((e) => e.clientEventId));

  let byHash: Map<string, Row> | null = null;
  let revoked: Set<string> | null = null;
  const carrierOf = async (h: string) => {
    if (!byHash) {
      byHash = new Map();
      for (const row of await store.carriers(null)) {
        const rh = qrOfflineHash(row[config.tokenField]);
        if (rh) byHash.set(rh, row);
      }
    }
    return byHash.get(h);
  };
  const isRevoked = async (h: string) => {
    revoked ??= new Set(await store.revokedHashes(null));
    return revoked.has(h);
  };

  const apply = async (ev: QrSyncEvent): Promise<{ result: QrSyncResult; firstScannedAt?: string }> => {
    const row = await carrierOf(ev.h);
    if (!row) return { result: (await isRevoked(ev.h)) ? "revoked" : "unknown" };
    if (!config.validStatuses.includes(String(row.status))) return { result: "revoked" };
    const at = Math.min(Date.parse(ev.scannedAt), now.getTime());
    const scannedAt = new Date(at).toISOString();
    const doc: Record<string, unknown> = { [config.checkin.refField]: row.id, scanned_at: scannedAt };
    const optional: Record<string, unknown> = { device_id: input.deviceId, gate: ev.gate, offline: true };
    for (const [k, v] of Object.entries(optional)) {
      if (v !== undefined && fieldOf(checkinEntity, k)) doc[k] = v;
    }
    try {
      await ctx.db.insert(config.checkin.entity, doc);
      return { result: "accepted" };
    } catch (e) {
      if (!(e instanceof UniqueViolation)) throw e;
    }
    const first = await ctx.db.getBy(config.checkin.entity, config.checkin.refField, row.id);
    const firstAt = first?.scanned_at ? Date.parse(String(first.scanned_at)) : Number.NaN;
    // The same event whose response was lost before _w_qr_events got it: the check-in is this device's own.
    if (first?.device_id === input.deviceId && first.offline === true && firstAt === at) {
      return { result: "accepted" };
    }
    if (first && !(firstAt <= at)) {
      await ctx.db.patch(config.checkin.entity, first.id, { scanned_at: scannedAt });
      return { result: "duplicate", firstScannedAt: scannedAt };
    }
    return {
      result: "duplicate",
      ...(Number.isFinite(firstAt) ? { firstScannedAt: new Date(firstAt).toISOString() } : {}),
    };
  };

  const results: QrSyncResponse["results"] = [];
  for (const ev of input.events) {
    const known = existing.get(ev.clientEventId);
    if (known) {
      results.push({ clientEventId: ev.clientEventId, result: known });
      continue;
    }
    const out = await apply(ev);
    const skew = Number.isFinite(sentAt)
      ? Math.abs(sentAt - now.getTime()) > QR_CLOCK_SKEW_MS
      : Date.parse(ev.scannedAt) - now.getTime() > QR_CLOCK_SKEW_MS;
    const stored = await store.saveEvent({
      clientEventId: ev.clientEventId,
      deviceId: input.deviceId,
      result: out.result,
      clockSkew: skew,
      receivedAt: now,
    });
    results.push({
      clientEventId: ev.clientEventId,
      result: stored,
      ...(stored === "duplicate" && out.firstScannedAt ? { firstScannedAt: out.firstScannedAt } : {}),
    });
  }
  await store.saveDevice({
    deviceId: input.deviceId,
    userId: input.userId,
    pending: input.pending ?? 0,
    lastSyncAt: now,
  });
  await store.purgeEvents(new Date(now.getTime() - QR_EVENT_RETENTION_MS));
  const count = (r: QrSyncResult) => results.filter((x) => x.result === r).length;
  return {
    forbidden: false,
    body: {
      results,
      accepted: count("accepted"),
      duplicate: count("duplicate"),
      unknown: count("unknown"),
      revoked: count("revoked"),
      cursor: encodeQrCursor(now),
    },
  };
}
