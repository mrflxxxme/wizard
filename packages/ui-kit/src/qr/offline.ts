// Offline part of QrScanner (connectors/qr.yaml#offline, ui-kit.yaml#components.QrScanner, M2-03): the package of
// ticket hashes and the queue of scans in IndexedDB, the hash check without a signature, batched sync.
// IndexedDB layout is shared with the runtime service worker (apps/runtime/src/pwa/sw-client.js): db "wz-qr",
// store "manifests" (keyPath "key", field expiresAt) — expired copies are deleted by the worker.
import type {
  QrManifest,
  QrManifestEntry,
  QrOfflineApi,
  QrSyncEvent,
  QrSyncResponse,
  QrSyncResult,
} from "../data/types.js";

export const QR_DB = "wz-qr";
const DB_VERSION = 1;
export const SYNC_BATCH = 500;
export const MANIFEST_REFRESH_MS = 60_000;
export const SYNC_EVERY_MS = 15_000;
const PAYLOAD_RE = /^WZ1\.[1-9][0-9]{0,5}\.([A-Z2-7]{26})\.[A-Za-z0-9_-]{16}$/;

export type StoredManifest = QrManifest & { key: string; local: string[] };
export type QueuedScan = QrSyncEvent & { seq: number };

/** Device storage of the scanner: IndexedDB in browsers, memory where IndexedDB is missing (tests, old WebViews). */
export interface QrOfflineStorage {
  deviceId(): Promise<string>;
  loadManifest(key: string): Promise<StoredManifest | null>;
  saveManifest(m: StoredManifest): Promise<void>;
  deleteManifest(key: string): Promise<void>;
  /** Queue in scan order. */
  queue(): Promise<QueuedScan[]>;
  enqueue(e: QueuedScan): Promise<void>;
  dequeue(ids: readonly string[]): Promise<void>;
}

function uuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function memoryStorage(): QrOfflineStorage {
  const manifests = new Map<string, StoredManifest>();
  const queue = new Map<string, QueuedScan>();
  const id = uuid();
  return {
    deviceId: async () => id,
    loadManifest: async (key) => structuredClone(manifests.get(key) ?? null),
    saveManifest: async (m) => void manifests.set(m.key, structuredClone(m)),
    deleteManifest: async (key) => void manifests.delete(key),
    queue: async () => [...queue.values()].sort((a, b) => a.seq - b.seq),
    enqueue: async (e) => void queue.set(e.clientEventId, { ...e }),
    dequeue: async (ids) => {
      for (const i of ids) queue.delete(i);
    },
  };
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function idbStorage(): QrOfflineStorage | null {
  const idb = globalThis.indexedDB;
  if (!idb) return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(QR_DB, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("manifests")) d.createObjectStore("manifests", { keyPath: "key" });
        if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue", { keyPath: "clientEventId" });
        if (!d.objectStoreNames.contains("device")) d.createObjectStore("device", { keyPath: "key" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return db;
  };
  const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const t = (await open()).transaction(store, mode);
    const out = req(fn(t.objectStore(store)));
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    return out;
  };
  return {
    async deviceId() {
      const hit = (await tx("device", "readonly", (s) => s.get("deviceId"))) as { id: string } | undefined;
      if (hit?.id) return hit.id;
      const id = uuid();
      await tx("device", "readwrite", (s) => s.add({ key: "deviceId", id })).catch(() => undefined);
      const again = (await tx("device", "readonly", (s) => s.get("deviceId"))) as { id: string } | undefined;
      return again?.id ?? id;
    },
    loadManifest: async (key) =>
      ((await tx("manifests", "readonly", (s) => s.get(key))) as StoredManifest | undefined) ?? null,
    saveManifest: async (m) => void (await tx("manifests", "readwrite", (s) => s.put(m))),
    deleteManifest: async (key) => void (await tx("manifests", "readwrite", (s) => s.delete(key))),
    queue: async () =>
      ((await tx("queue", "readonly", (s) => s.getAll())) as QueuedScan[]).sort((a, b) => a.seq - b.seq),
    enqueue: async (e) => void (await tx("queue", "readwrite", (s) => s.put(e))),
    dequeue: async (ids) => {
      if (ids.length === 0) return;
      const t = (await open()).transaction("queue", "readwrite");
      const s = t.objectStore("queue");
      for (const i of ids) s.delete(i);
      await new Promise<void>((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },
  };
}

/** IndexedDB when available, otherwise memory (the queue then lives until the page is closed). */
export function openQrStorage(): QrOfflineStorage {
  return idbStorage() ?? memoryStorage();
}

/** rand of a WZ1 payload; the signature is not checked offline (no key on the device). */
export function payloadRand(payload: string): string | null {
  return PAYLOAD_RE.exec(payload.trim())?.[1] ?? null;
}

/** h = base64url(sha256(rand))[0:22] (connectors/qr.yaml#offline.package). */
export async function offlineHash(rand: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(rand)),
  );
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

/** Device copy after a server answer: full replaces, delta merges (entries by id, sets by union). */
export function mergeManifest(prev: StoredManifest | null, next: QrManifest, key: string): StoredManifest {
  const base = next.full || !prev ? null : prev;
  const entries = new Map<string, QrManifestEntry>((base?.entries ?? []).map((e) => [e.id, e]));
  for (const e of next.entries) entries.set(e.id, e);
  const checkedIn = new Set([...(base?.checkedIn ?? []), ...next.checkedIn]);
  return {
    ...next,
    key,
    full: true,
    entries: [...entries.values()],
    checkedIn: [...checkedIn],
    revoked: [...new Set([...(base?.revoked ?? []), ...next.revoked])],
    // Local scans stay until the server reports them in checkedIn.
    local: (prev?.local ?? []).filter((h) => !checkedIn.has(h)),
  };
}

export type OfflineVerdict = {
  status: "queued" | "duplicate" | "invalid";
  reason?: "no_manifest" | "bad_format" | "not_found" | "revoked" | "not_valid_status";
  entry?: QrManifestEntry;
  scannedAt: string;
  clientEventId?: string;
};

export type OfflineScannerOptions = {
  /** Copy key on the device (one per QR integration of the system host). */
  key?: string;
  gate: string;
  now?: () => Date;
  onChange?: () => void;
};

/**
 * Package, local check and queue of one scanner screen. `scan` never awaits between the duplicate check and the
 * local mark, so two quick scans of one code cannot both pass.
 */
export class OfflineScanner {
  deviceId = "";
  tickets = 0;
  pending = 0;
  expiresAt: string | null = null;
  private manifest: StoredManifest | null = null;
  private byHash = new Map<string, QrManifestEntry>();
  private seen = new Set<string>();
  private revoked = new Set<string>();
  private valid = new Set<string>();
  private seq = 0;
  private syncing: Promise<QrSyncResponse["results"]> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private readonly key: string;
  private readonly now: () => Date;
  readonly ready: Promise<void>;

  constructor(
    private readonly api: QrOfflineApi,
    private readonly storage: QrOfflineStorage,
    private readonly o: OfflineScannerOptions,
  ) {
    this.key = o.key ?? "default";
    this.now = o.now ?? (() => new Date());
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    this.deviceId = await this.storage.deviceId();
    const m = await this.storage.loadManifest(this.key);
    if (m && Date.parse(m.expiresAt) > this.now().getTime()) this.index(m);
    else if (m) await this.storage.deleteManifest(this.key);
    const q = await this.storage.queue();
    this.pending = q.length;
    this.seq = Math.max(this.now().getTime() * 1000, ...q.map((e) => e.seq + 1));
    for (const e of q) this.seen.add(e.h);
    this.o.onChange?.();
  }

  private index(m: StoredManifest): void {
    this.manifest = m;
    this.byHash = new Map(m.entries.map((e) => [e.h, e]));
    this.seen = new Set([...m.checkedIn, ...m.local, ...[...this.seen].filter((h) => this.byHash.has(h))]);
    this.revoked = new Set(m.revoked);
    this.valid = new Set(m.validStatuses);
    this.tickets = m.entries.length;
    this.expiresAt = m.expiresAt;
  }

  get hasManifest(): boolean {
    return this.manifest !== null && Date.parse(this.manifest.expiresAt) > this.now().getTime();
  }

  /** Downloads the package (delta by cursor when a copy exists); false when the network or server failed. */
  refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        await this.ready;
        const since = this.hasManifest ? this.manifest?.cursor : undefined;
        const next = await this.api.manifest(since);
        const merged = mergeManifest(this.hasManifest ? this.manifest : null, next, this.key);
        const server = new Set(merged.checkedIn);
        merged.local = [...new Set([...merged.local, ...this.seen])].filter((h) => !server.has(h));
        await this.storage.saveManifest(merged);
        this.index(merged);
        this.o.onChange?.();
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** A ticket the server just let in online: an offline repeat before the next refresh is a duplicate too. */
  async markSeen(payload: string): Promise<void> {
    const rand = payloadRand(payload);
    if (rand) this.seen.add(await offlineHash(rand));
  }

  /** Offline check of a payload by hash; ok → queued event (connectors/qr.yaml#offline.scan). */
  async scan(payload: string): Promise<OfflineVerdict> {
    await this.ready;
    const scannedAt = this.now().toISOString();
    if (!this.hasManifest) return { status: "invalid", reason: "no_manifest", scannedAt };
    const rand = payloadRand(payload);
    if (!rand) return { status: "invalid", reason: "bad_format", scannedAt };
    const h = await offlineHash(rand);
    const entry = this.byHash.get(h);
    if (!entry) {
      return { status: "invalid", reason: this.revoked.has(h) ? "revoked" : "not_found", scannedAt };
    }
    if (!this.valid.has(entry.s)) return { status: "invalid", reason: "not_valid_status", entry, scannedAt };
    if (this.seen.has(h)) return { status: "duplicate", entry, scannedAt };
    this.seen.add(h);
    const event: QueuedScan = {
      clientEventId: uuid(),
      h,
      scannedAt,
      gate: this.o.gate,
      localResult: "queued",
      seq: this.seq++,
    };
    this.pending++;
    this.o.onChange?.();
    await this.storage.enqueue(event);
    return { status: "queued", entry, scannedAt, clientEventId: event.clientEventId };
  }

  /** Sends the queue in order, ≤ 500 per call; only confirmed events leave it. Network errors stop the pass. */
  sync(): Promise<QrSyncResponse["results"]> {
    this.syncing ??= (async () => {
      const out: QrSyncResponse["results"] = [];
      try {
        await this.ready;
        for (;;) {
          const queue = await this.storage.queue();
          this.pending = queue.length;
          if (queue.length === 0) break;
          const batch = queue.slice(0, SYNC_BATCH);
          let res: QrSyncResponse;
          try {
            res = await this.api.sync({
              deviceId: this.deviceId,
              events: batch.map(({ seq: _s, ...e }) => e),
              sentAt: this.now().toISOString(),
              pending: queue.length - batch.length,
            });
          } catch {
            break;
          }
          const done = res.results.map((r) => r.clientEventId);
          // Synced scans stay marked on the device until the package lists them in checkedIn.
          const hashes = new Map(batch.map((e) => [e.clientEventId, e.h]));
          if (this.manifest) {
            const local = new Set(this.manifest.local);
            for (const id of done) {
              const h = hashes.get(id);
              if (h) local.add(h);
            }
            this.manifest.local = [...local];
            await this.storage.saveManifest(this.manifest);
          }
          await this.storage.dequeue(done);
          this.pending = queue.length - done.length;
          out.push(...res.results);
          this.o.onChange?.();
          if (done.length === 0) break;
        }
      } finally {
        this.syncing = null;
        this.o.onChange?.();
      }
      return out;
    })();
    return this.syncing;
  }
}

export type { QrSyncResult };
