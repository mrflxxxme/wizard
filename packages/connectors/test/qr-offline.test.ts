// M2-03: QR offline package and sync (qr.yaml#offline) on the forum reference spec with in-memory doubles.
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  decodeQrCursor,
  encodeQrCursor,
  invokeAction,
  issueQrToken,
  newQrKeyring,
  parseQrPayload,
  parseQrSyncBody,
  QR_MANIFEST_TTL_MS,
  type QrConfig,
  type QrSyncEvent,
  qrCheck,
  qrConnector,
  qrManifest,
  qrOfflineHash,
  qrSync,
  qrTokenHash,
  serializeQrKeyring,
} from "../src/index.js";
import { createTestCtx, MemoryQrOfflineStore, MemoryStore, MemorySystemDb } from "../src/testing.js";
import { loadSpec } from "./helpers.js";

const spec = loadSpec("forum");
const qrKey = serializeQrKeyring(newQrKeyring());
const T0 = new Date("2026-11-01T08:00:00.000Z");

async function setup(o: { tickets?: number; offline?: boolean; now?: () => Date } = {}) {
  const s = structuredClone(spec);
  const integ = s.integrations?.find((i) => i.connector === "qr");
  if (o.offline === false && integ) (integ.config as QrConfig).offline = false;
  const db = new MemorySystemDb(s);
  const kv = new MemoryStore();
  const ctx = createTestCtx({
    spec: s,
    integration: "qr",
    db,
    store: kv,
    secrets: { qr_signing_key: qrKey },
    now: o.now ?? (() => T0),
  });
  const store = new MemoryQrOfflineStore(db, kv, ctx.integration.config as QrConfig);
  const stream = await db.insert("stream", { name: "Технологии", capacity: 100 });
  const type = await db.insert("ticket_type", { name: "VIP", kind: "vip", price: 3025, active: true });
  const tickets: { id: string; token: string; h: string }[] = [];
  for (let i = 0; i < (o.tickets ?? 3); i++) {
    const token = await issueQrToken(ctx);
    const id = await db.insert("ticket", {
      ticket_type: type,
      stream,
      holder_name: `Иван Петров ${i}`,
      holder_email: `ivan${i}@example.ru`,
      status: "paid",
      amount: 3025,
      qr_token: token,
    });
    tickets.push({ id, token, h: qrOfflineHash(token) as string });
  }
  return { db, kv, ctx, store, tickets };
}

const ev = (h: string, at = T0, gate = "Вход А"): QrSyncEvent => ({
  clientEventId: randomUUID(),
  h,
  scannedAt: at.toISOString(),
  gate,
  localResult: "queued",
});

describe("qrManifest", () => {
  test("entries carry h, id, display line and status — no token, rand, key or PII", async () => {
    const { ctx, store, tickets } = await setup();
    const out = await qrManifest(ctx, "volunteer", store, {});
    if (out.forbidden) throw new Error("forbidden");
    const m = out.body;
    expect(m.full).toBe(true);
    expect(m.validStatuses).toEqual(["paid", "issued"]);
    expect(m.entries).toHaveLength(3);
    const first = tickets[0];
    if (!first) throw new Error("no ticket");
    expect(m.entries.find((e) => e.id === first.id)).toEqual({
      h: qrTokenHash(parseQrPayload(first.token)?.rand ?? ""),
      id: first.id,
      d: "VIP · Технологии",
      s: "paid",
    });
    const json = JSON.stringify(m);
    for (const t of tickets) {
      expect(json).not.toContain(t.token);
      expect(json).not.toContain(parseQrPayload(t.token)?.rand);
    }
    expect(json).not.toMatch(/Иван|example\.ru|amount|holder/);
    expect(Date.parse(m.expiresAt) - Date.parse(m.generatedAt)).toBe(QR_MANIFEST_TTL_MS);
    expect(decodeQrCursor(m.cursor)?.toISOString()).toBe(T0.toISOString());
  });

  test("checkedIn holds hashes of online check-ins; revoked holds the old hash after revoke", async () => {
    const { ctx, store, tickets } = await setup();
    const [a, b] = tickets;
    if (!a || !b) throw new Error("no tickets");
    await qrCheck(ctx, "volunteer", { payload: a.token, deviceId: "d1" });
    await invokeAction(qrConnector, "revoke", ctx, { entity: "ticket", id: b.id });
    const out = await qrManifest(ctx, "volunteer", store, {});
    if (out.forbidden) throw new Error("forbidden");
    expect(out.body.checkedIn).toEqual([a.h]);
    expect(out.body.revoked).toEqual([b.h]);
    expect(out.body.entries.find((e) => e.id === b.id)?.h).not.toBe(b.h);
  });

  test("a cursor older than the TTL or malformed → full package", async () => {
    const { ctx, store } = await setup();
    const stale = encodeQrCursor(new Date(T0.getTime() - QR_MANIFEST_TTL_MS - 1));
    for (const since of [stale, "garbage", encodeQrCursor(new Date(T0.getTime() + 60_000))]) {
      const out = await qrManifest(ctx, "volunteer", store, { since });
      expect(out.forbidden === false && out.body.full).toBe(true);
    }
    const fresh = await qrManifest(ctx, "volunteer", store, { since: encodeQrCursor(T0) });
    expect(fresh.forbidden === false && fresh.body.full).toBe(false);
  });

  test("role outside scannerRoles → forbidden; offline not enabled → offline_disabled", async () => {
    const { ctx, store } = await setup();
    expect(await qrManifest(ctx, "participant", store, {})).toEqual({ forbidden: true, reason: "role" });
    const off = await setup({ offline: false });
    expect(await qrManifest(off.ctx, "volunteer", off.store, {})).toEqual({
      forbidden: true,
      reason: "offline_disabled",
    });
    expect(
      await qrSync(off.ctx, "volunteer", off.store, { deviceId: "d", userId: null, events: [] }),
    ).toEqual({
      forbidden: true,
      reason: "offline_disabled",
    });
  });
});

describe("qrSync", () => {
  test("100 offline scans on two devices with 10 overlaps → 90 accepted, 10 duplicate; re-send changes nothing", async () => {
    const { ctx, store, db, tickets } = await setup({ tickets: 90 });
    const a = tickets.slice(0, 55).map((t) => ev(t.h));
    const b = tickets.slice(45, 90).map((t) => ev(t.h, new Date(T0.getTime() + 60_000), "Вход Б"));
    const ra = await qrSync(ctx, "volunteer", store, { deviceId: "dev-a", userId: null, events: a });
    const rb = await qrSync(ctx, "volunteer", store, { deviceId: "dev-b", userId: null, events: b });
    if (ra.forbidden || rb.forbidden) throw new Error("forbidden");
    expect(ra.body.accepted + rb.body.accepted).toBe(90);
    expect(ra.body.duplicate + rb.body.duplicate).toBe(10);
    expect(rb.body.duplicate).toBe(10);
    expect(await db.list("checkin")).toHaveLength(90);
    const again = await qrSync(ctx, "volunteer", store, { deviceId: "dev-b", userId: null, events: b });
    if (again.forbidden) throw new Error("forbidden");
    expect(again.body.results.map((r) => r.result)).toEqual(rb.body.results.map((r) => r.result));
    expect(await db.list("checkin")).toHaveLength(90);
    const offline = (await db.list("checkin")).filter((c) => c.offline === true && c.device_id);
    expect(offline).toHaveLength(90);
  });

  test("first scan wins: an earlier duplicate moves scanned_at to the earliest time", async () => {
    const { ctx, store, db, tickets } = await setup();
    const t = tickets[0];
    if (!t) throw new Error("no ticket");
    const later = new Date(T0.getTime() - 60_000);
    const earlier = new Date(T0.getTime() - 5 * 60_000);
    await qrSync(ctx, "volunteer", store, { deviceId: "dev-a", userId: null, events: [ev(t.h, later)] });
    const r = await qrSync(ctx, "volunteer", store, {
      deviceId: "dev-b",
      userId: null,
      events: [ev(t.h, earlier)],
    });
    expect(r).toMatchObject({
      body: { duplicate: 1, results: [{ result: "duplicate", firstScannedAt: earlier.toISOString() }] },
    });
    const [c] = await db.list("checkin");
    expect(c?.scanned_at).toBe(earlier.toISOString());
    expect(c?.device_id).toBe("dev-a");
  });

  test("unknown hash → unknown; revoked token → revoked; canceled ticket → revoked", async () => {
    const { ctx, store, db, tickets } = await setup();
    const [a, b] = tickets;
    if (!a || !b) throw new Error("no tickets");
    await invokeAction(qrConnector, "revoke", ctx, { entity: "ticket", id: a.id });
    await db.patch("ticket", b.id, { status: "canceled" });
    const r = await qrSync(ctx, "volunteer", store, {
      deviceId: "dev-a",
      userId: null,
      events: [ev("A".repeat(22)), ev(a.h), ev(b.h)],
    });
    if (r.forbidden) throw new Error("forbidden");
    expect(r.body.results.map((x) => x.result)).toEqual(["unknown", "revoked", "revoked"]);
    expect(await db.list("checkin")).toHaveLength(0);
  });

  test("a replay whose result was lost is still accepted for the same device", async () => {
    const { ctx, store, tickets } = await setup();
    const t = tickets[0];
    if (!t) throw new Error("no ticket");
    const e = ev(t.h);
    await qrSync(ctx, "volunteer", store, { deviceId: "dev-a", userId: null, events: [e] });
    store.qrEvents.clear();
    const r = await qrSync(ctx, "volunteer", store, { deviceId: "dev-a", userId: null, events: [e] });
    expect(r).toMatchObject({ body: { accepted: 1 } });
  });

  test("scan times in the future are clamped; device clock off by > 10 min → clock_skew; device row kept", async () => {
    const { ctx, store, db, tickets } = await setup();
    const t = tickets[0];
    if (!t) throw new Error("no ticket");
    const e = ev(t.h, new Date(T0.getTime() + 3_600_000));
    await qrSync(ctx, "volunteer", store, {
      deviceId: "dev-a",
      userId: "u1",
      events: [e],
      sentAt: new Date(T0.getTime() + 11 * 60_000).toISOString(),
      pending: 7,
    });
    expect(store.qrEvents.get(e.clientEventId)).toMatchObject({ result: "accepted", clockSkew: true });
    expect(store.devices.get("dev-a")).toMatchObject({ userId: "u1", pending: 7, lastSyncAt: T0 });
    expect((await db.list("checkin"))[0]?.scanned_at).toBe(T0.toISOString());
  });

  test("events are kept 7 days", async () => {
    let now = T0;
    const { ctx, store, tickets } = await setup({ now: () => now });
    const t = tickets[0];
    if (!t) throw new Error("no ticket");
    const e = ev(t.h);
    await qrSync(ctx, "volunteer", store, { deviceId: "d", userId: null, events: [e] });
    now = new Date(T0.getTime() + 8 * 24 * 3_600_000);
    await qrSync(ctx, "volunteer", store, { deviceId: "d", userId: null, events: [] });
    expect(store.qrEvents.has(e.clientEventId)).toBe(false);
  });

  test("body validation: ≤ 500 events, uuid ids, 22-char hashes, ISO times", () => {
    const many = Array.from({ length: 501 }, () => ev("A".repeat(22)));
    const r = parseQrSyncBody({ deviceId: "d", events: many });
    expect(r).toMatchObject({
      ok: false,
      fields: [{ field: "events", message: "Не больше 500 отметок за раз" }],
    });
    expect(
      parseQrSyncBody({ deviceId: "d", events: [{ ...ev("A".repeat(22)), clientEventId: "x" }] }).ok,
    ).toBe(false);
    expect(parseQrSyncBody({ deviceId: "d", events: [ev("short")] }).ok).toBe(false);
    expect(
      parseQrSyncBody({ deviceId: "d", events: [{ ...ev("A".repeat(22)), scannedAt: "вчера" }] }).ok,
    ).toBe(false);
    expect(parseQrSyncBody({ deviceId: "d", events: [ev("A".repeat(22))], pending: 3 }).ok).toBe(true);
  });
});
