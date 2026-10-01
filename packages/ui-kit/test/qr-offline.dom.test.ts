// @vitest-environment happy-dom
// M2-03: offline core of QrScanner (connectors/qr.yaml#offline.scan, #sync_protocol) and the component in offline
// mode on the memory DataSource («форум» fixture, WZ1-shaped tokens).
import { act, createElement as h } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { forum, forumFixture } from "../demo/fixtures.js";
import { QrScanner } from "../src/index.js";
import { mergeManifest, type QueuedScan } from "../src/qr/offline.js";
import {
  createMemoryDataSource,
  memoryQrToken,
  memoryStorage,
  OfflineScanner,
  offlineHash,
  payloadRand,
} from "../src/testing/index.js";
import { flush, type Rendered, render, type } from "./helpers/dom.js";

const fixture = () => {
  const f = forumFixture();
  const ds = createMemoryDataSource(forum, f.rows, { users: f.users, userId: "u_volunteer" });
  const tickets = (f.rows.ticket ?? []).map((t) => ({ id: t.id, token: String(t.qr_token) }));
  return { ds, tickets };
};

describe("OfflineScanner", () => {
  test("hash check without the network: queued, local repeat → duplicate, unknown/garbage/no package → invalid", async () => {
    const { ds, tickets } = fixture();
    const s = new OfflineScanner(ds.qrOffline, memoryStorage(), { gate: "Вход А" });
    const [a] = tickets;
    if (!a) throw new Error("no tickets");
    expect(await s.scan(a.token)).toMatchObject({ status: "invalid", reason: "no_manifest" });
    expect(await s.refresh()).toBe(true);
    expect(s.tickets).toBe(tickets.length);
    const ok = await s.scan(a.token);
    expect(ok).toMatchObject({ status: "queued", entry: { id: a.id, s: "paid" } });
    expect(ok.entry?.d).toMatch(/ · /);
    expect(await s.scan(a.token)).toMatchObject({ status: "duplicate" });
    expect(await s.scan(memoryQrToken("чужой"))).toMatchObject({ status: "invalid", reason: "not_found" });
    expect(await s.scan("это не билет")).toMatchObject({ status: "invalid", reason: "bad_format" });
    expect(s.pending).toBe(1);
  });

  test("h = base64url(sha256(rand))[0:22] — the server formula (qr.yaml#offline.package)", async () => {
    const rand = payloadRand(memoryQrToken("x")) as string;
    expect(rand).toMatch(/^[A-Z2-7]{26}$/);
    const h = await offlineHash(rand);
    expect(h).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // node:crypto reference
    const { createHash } = await import("node:crypto");
    expect(h).toBe(createHash("sha256").update(rand).digest("base64url").slice(0, 22));
  });

  test("ticket checked in online elsewhere is a repeat offline; canceled ticket is invalid", async () => {
    const { ds, tickets } = fixture();
    const [a, b] = tickets;
    if (!a || !b) throw new Error("no tickets");
    ds.qrCheck({ payload: a.token, deviceId: "other" });
    const row = ds.rows("ticket").find((r) => r.id === b.id);
    if (row) row.status = "canceled";
    const s = new OfflineScanner(ds.qrOffline, memoryStorage(), { gate: "Вход А" });
    await s.refresh();
    expect(await s.scan(a.token)).toMatchObject({ status: "duplicate" });
    expect(await s.scan(b.token)).toMatchObject({ status: "invalid", reason: "not_valid_status" });
  });

  test("two devices with overlaps → server keeps one check-in per ticket; a re-sent batch changes nothing", async () => {
    const { ds, tickets } = fixture();
    const a = new OfflineScanner(ds.qrOffline, memoryStorage(), { gate: "Вход А" });
    const b = new OfflineScanner(ds.qrOffline, memoryStorage(), { gate: "Вход Б" });
    await Promise.all([a.refresh(), b.refresh()]);
    const n = tickets.length;
    for (const t of tickets.slice(0, 12)) expect((await a.scan(t.token)).status).toBe("queued");
    for (const t of tickets.slice(9, n)) expect((await b.scan(t.token)).status).toBe("queued");
    const ra = await a.sync();
    const rb = await b.sync();
    expect(ra.every((r) => r.result === "accepted")).toBe(true);
    expect(rb.filter((r) => r.result === "duplicate")).toHaveLength(3);
    expect(rb.filter((r) => r.result === "accepted")).toHaveLength(n - 12);
    expect(ds.qrCheckins().size).toBe(n);
    expect(a.pending + b.pending).toBe(0);
    const again = await ds.qrOffline.sync({
      deviceId: b.deviceId,
      events: rb.map((r) => ({ clientEventId: r.clientEventId, h: "x".repeat(22), scannedAt: "" })),
    });
    expect(again.results.map((r) => r.result)).toEqual(rb.map((r) => r.result));
    expect(ds.qrCheckins().size).toBe(n);
  });

  test("sync sends ≤ 500 events per call in scan order; a network error keeps the queue", async () => {
    const storage = memoryStorage();
    const batches: number[] = [];
    let fail = true;
    const seen: string[] = [];
    const api = {
      manifest: async () => {
        throw new Error("offline");
      },
      sync: async (req: { events: { clientEventId: string }[] }) => {
        if (fail) throw Object.assign(new Error("Нет сети"), { code: "NETWORK", status: 0 });
        batches.push(req.events.length);
        seen.push(...req.events.map((e) => e.clientEventId));
        return {
          results: req.events.map((e) => ({ clientEventId: e.clientEventId, result: "accepted" as const })),
          accepted: req.events.length,
          duplicate: 0,
          unknown: 0,
          revoked: 0,
          cursor: "c",
        };
      },
    };
    const ids: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const e: QueuedScan = {
        clientEventId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        h: "A".repeat(22),
        scannedAt: new Date().toISOString(),
        seq: i,
      };
      ids.push(e.clientEventId);
      await storage.enqueue(e);
    }
    const s = new OfflineScanner(api, storage, { gate: "A" });
    await s.ready;
    expect(s.pending).toBe(1200);
    expect(await s.sync()).toEqual([]);
    expect(s.pending).toBe(1200);
    fail = false;
    expect(await s.sync()).toHaveLength(1200);
    expect(batches).toEqual([500, 500, 200]);
    expect(seen).toEqual(ids);
    expect(await storage.queue()).toHaveLength(0);
  });

  test("delta merge: entries by id, sets by union; expired copy is dropped on start", async () => {
    const base = {
      manifestId: "m",
      cursor: "1",
      generatedAt: "",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      validStatuses: ["paid"],
      revoked: [],
    };
    const full = mergeManifest(
      null,
      { ...base, full: true, entries: [{ h: "a", id: "1", d: "", s: "paid" }], checkedIn: ["x"] },
      "default",
    );
    const next = mergeManifest(
      { ...full, local: ["a", "y"] },
      { ...base, full: false, entries: [{ h: "b", id: "1", d: "", s: "canceled" }], checkedIn: ["y"] },
      "default",
    );
    expect(next.entries).toEqual([{ h: "b", id: "1", d: "", s: "canceled" }]);
    expect(next.checkedIn.sort()).toEqual(["x", "y"]);
    expect(next.local).toEqual(["a"]);
    const storage = memoryStorage();
    await storage.saveManifest({ ...next, expiresAt: new Date(Date.now() - 1).toISOString() });
    const s = new OfflineScanner(
      { manifest: async () => Promise.reject(), sync: async () => Promise.reject() },
      storage,
      {
        gate: "A",
      },
    );
    await s.ready;
    expect(s.hasManifest).toBe(false);
    expect(await storage.loadManifest("default")).toBeNull();
  });
});

describe("QrScanner offline", () => {
  let r: Rendered | undefined;
  let online = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  afterEach(() => {
    r?.unmount();
    r = undefined;
    online = true;
  });
  const status = () => r?.$("wz-qrscanner-status") as HTMLElement;
  const scan = async (code: string) => {
    const form = r?.$("wz-qrscanner-manual") as HTMLFormElement;
    await type(form.querySelector("input") as Element, code);
    await act(async () => {
      form.requestSubmit();
    });
    await flush();
  };
  const waitFor = async (cond: () => boolean) => {
    const ok = () => {
      try {
        return cond();
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 500 && !ok(); i++) await act(async () => new Promise((res) => setTimeout(res, 10)));
    expect(cond()).toBe(true);
  };

  test("no network: «Принято офлайн», queue in the status line; back online → queue sent, counters kept", async () => {
    const { ds, tickets } = fixture();
    r = await render(h(QrScanner, { checkpoint: "Вход А", offline: true }), {
      app: forum,
      role: "volunteer",
      ds,
    });
    await waitFor(() => status().dataset.tickets === String(tickets.length));
    online = false;
    await act(async () => window.dispatchEvent(new Event("offline")));
    const [a, b] = tickets;
    if (!a || !b) throw new Error("no tickets");
    await scan(a.token);
    await waitFor(() => r?.$("wz-qrscanner-result").dataset.status === "queued");
    expect(r.$("wz-qrscanner-result").textContent).toContain("Принято офлайн");
    await scan(b.token);
    await waitFor(() => status().dataset.pending === "2");
    expect(status().textContent).toBe(
      `● Нет сети · ${tickets.length} билетов в памяти · 2 отметок ждут синхронизации`,
    );
    await scan(a.token);
    await waitFor(() => r?.$("wz-qrscanner-result").dataset.status === "duplicate");
    expect(r.$("wz-qrscanner-result").textContent).toContain("Повторный вход");
    expect(ds.calls.filter((c) => c.op === "qrCheck")).toHaveLength(0);

    online = true;
    await act(async () => window.dispatchEvent(new Event("online")));
    await waitFor(() => status().dataset.pending === "0");
    expect(ds.qrCheckins().size).toBe(2);
    expect(r.$("wz-qrscanner-counters").textContent).toMatch(/Прошли2.*Повторных1/);
    expect(status().textContent).toContain("Синхронизировано");
    // Online again: the server answers a repeat.
    await scan(a.token);
    await waitFor(() => r?.$("wz-qrscanner-result").dataset.status === "duplicate");
    expect(ds.calls.filter((c) => c.op === "qrCheck")).toHaveLength(1);
  });
});
