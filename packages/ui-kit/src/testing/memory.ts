// createMemoryDataSource (ui-kit.yaml#data_binding.testing): in-memory data API with the runtime's permission
// semantics (runtime.yaml#permissions: ops, rowFilter by $user.*, hiddenFields, readonlyFields, consent).
import type { AppSpec, Entity, Permission } from "@wizard/appspec";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toWzError, useMutationState } from "../data/mutation.js";
import type {
  AiActionResult,
  AsyncResult,
  AuthApi,
  DataSource,
  FileInfo,
  FileMimeType,
  FilesApi,
  ListQuery,
  QrCheckRequest,
  QrCheckResponse,
  QrManifestEntry,
  QrOfflineApi,
  QrSyncResponse,
  QrSyncResult,
  Rec,
  UserResult,
  WriteOpts,
  WzError,
  WzUser,
} from "../data/types.js";
import { fieldProblem } from "../data/validate.js";
import { ru } from "../i18n/ru.js";
import { offlineHash, payloadRand } from "../qr/offline.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SIG = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Deterministic token in the WZ1 shape (connectors/qr.yaml#token.payload); the signature is fake. */
export function memoryQrToken(seed: string): string {
  let x = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) x = Math.imul(x ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  const next = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  const pick = (alphabet: string, n: number) =>
    Array.from({ length: n }, () => alphabet[next() % alphabet.length]).join("");
  return `WZ1.1.${pick(B32, 26)}.${pick(SIG, 16)}`;
}

export type MemoryUser = WzUser & { phone?: string; email?: string; [attr: string]: unknown };
export type MemoryFnCtx = { user: MemoryUser | null; ds: MemoryDataSource };
export type MemoryFn = (args: unknown, ctx: MemoryFnCtx) => unknown;
export type MemoryCall = { op: string; entity?: string; name?: string; args: unknown[] };
export type MemoryOutboxMessage = { channel: "phone" | "email"; destination: string; code: string };

export interface MemoryOptions {
  users?: MemoryUser[];
  /** Initially logged-in user id (default: nobody). */
  userId?: string | null;
  /** query/mutation functions for useFn/useCall. */
  functions?: Record<string, MemoryFn>;
  /** Simulated latency of reads (default 0: synchronous). */
  latencyMs?: number;
  now?: () => Date;
  /** Role of a new user created by OTP login (default: first selfSignup role). */
  signupRole?: string;
  /** A new user's verify without consent → CONSENT_REQUIRED (runtime.yaml#auth.consent_at_login). */
  consentAtLogin?: boolean;
  /** Called by useUser().login (default: history push to /login). */
  navigate?: (to: string) => void;
  /**
   * AI actions (M3-02) by name: entity and a fill function over the stored row (the "model"); the result is written
   * like the runtime does — as __system, marking the fields in `_aiFilled` until a user edits them.
   */
  aiActions?: Record<string, MemoryAiAction>;
  /** Picture addresses of image-field values (fileId → URL) for demos; uploads get an object URL of the file. */
  images?: Record<string, string>;
  /** V3-23: the confirmation URL usePay gives (default: the draft mock page of the binding and the record). */
  pay?: (i: { integration: string; binding: string; id: string; token?: string }) => string;
}

export type MemoryAiAction = { entity: string; fill: (row: Rec) => Record<string, unknown> };

const SYSTEM = ["id", "created_at", "updated_at", "created_by"] as const;
const OPS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains"]);
const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The runtime's signature allowlist (runtime.yaml#files.upload), for memory uploads. */
function sniffFile(b: Uint8Array): FileMimeType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  return null;
}

export function wzError(code: string, extra: Partial<WzError> = {}): WzError {
  const messages: Record<string, string> = ru.server;
  const status = STATUS[code] ?? (messages[code] ? 422 : 400);
  return { code, message: messages[code] ?? ru.server.rejected, status, ...extra };
}

const cmp = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
};

export interface MemoryDataSource extends DataSource {
  /** Every DataSource call, in order (tests: "0 calls to create"). */
  readonly calls: MemoryCall[];
  readonly outbox: MemoryOutboxMessage[];
  getUser(): MemoryUser | null;
  /** Store version, bumped on every write, login and dev-sender message. */
  version(): number;
  setUser(id: string | null): void;
  subscribe(cb: () => void): () => void;
  /** Raw rows (no permission filtering). */
  rows(entity: string): Rec[];
  /** Next matching write fails with `error` (e.g. 403 for optimistic-update tests). */
  failNext(op: "create" | "update" | "remove" | "call" | "ai" | "pay", error: WzError): void;
  /** Permission-checked operations (also used by the hooks). */
  list(entity: string, q?: ListQuery): { items: Rec[]; total: number };
  get(entity: string, id: string): Rec;
  create(entity: string, values: Record<string, unknown>, opts?: WriteOpts): Rec;
  update(entity: string, id: string, patch: Record<string, unknown>, opts?: WriteOpts): Rec;
  remove(entity: string, id: string): void;
  /** Non-hook access to the dev-sender auth and QR check (tests). */
  auth: AuthApi;
  qrCheck(req: QrCheckRequest): QrCheckResponse;
  /** Non-hook offline package and sync (tests). */
  readonly qrOffline: QrOfflineApi;
  /** Check-ins made by qrCheck and sync: token → first scan. */
  qrCheckins(): Map<string, { at: string; checkpoint?: string }>;
  /** Non-hook AI action run (POST /api/ai/:action semantics: update permission, rowFilter, `_aiFilled`). */
  runAi(action: string, entity: string, id: string): AiActionResult;
  /** Non-hook file uploads (signature allowlist and 10 МБ like the runtime) and the stored files. */
  readonly files: FilesApi & { stored(): Map<string, FileInfo & { field: string; entity?: string }> };
}

export function createMemoryDataSource(
  spec: AppSpec,
  fixtures: Record<string, Record<string, unknown>[]> = {},
  opts: MemoryOptions = {},
): MemoryDataSource {
  const now = opts.now ?? (() => new Date());
  const db = new Map<string, Rec[]>();
  let seq = 0;
  const nextId = (entity: string) => `${entity}_${(++seq).toString().padStart(4, "0")}`;
  for (const e of spec.entities) {
    db.set(
      e.name,
      (fixtures[e.name] ?? []).map((r) => ({
        created_at: now().toISOString(),
        updated_at: null,
        created_by: null,
        ...r,
        id: String(r.id ?? nextId(e.name)),
      })),
    );
  }
  const users = new Map((opts.users ?? []).map((u) => [u.id, { ...u }]));
  let current: MemoryUser | null = opts.userId ? (users.get(opts.userId) ?? null) : null;
  let version = 0;
  const listeners = new Set<() => void>();
  const bump = () => {
    version++;
    for (const l of [...listeners]) l();
  };
  const calls: MemoryCall[] = [];
  const outbox: MemoryOutboxMessage[] = [];
  const failures: { op: string; error: WzError }[] = [];
  const checkins = new Map<string, { at: string; checkpoint?: string }>();
  /** `${entity}:${id}` → fields whose last write was an AI action. */
  const aiMeta = new Map<string, Set<string>>();
  const withMeta = (entity: string, row: Rec): Rec => {
    const marked = aiMeta.get(`${entity}:${row.id}`);
    return marked?.size ? { ...row, _aiFilled: [...marked].filter((f) => f in row) } : row;
  };
  const challenges = new Map<string, MemoryOutboxMessage>();

  const entityOf = (name: string): Entity => {
    const e = spec.entities.find((x) => x.name === name);
    if (!e) throw wzError("NOT_FOUND");
    return e;
  };
  const roleName = () => current?.role ?? spec.roles.find((r) => r.access === "public")?.name ?? null;
  const isAdmin = () => !!spec.roles.find((r) => r.name === roleName())?.isAdmin;
  const perm = (entity: string, op: "read" | "create" | "update" | "delete"): Permission => {
    const role = roleName();
    if (!role) throw wzError("UNAUTHENTICATED");
    const p = spec.permissions.find((x) => x.role === role && x.entity === entity);
    if (!p?.ops.includes(op)) throw wzError(current ? "FORBIDDEN" : "UNAUTHENTICATED");
    return p;
  };
  const filterValue = (v: unknown): unknown => {
    if (typeof v !== "string" || !v.startsWith("$user.")) return v;
    if (!current) return undefined;
    return current[v.slice(6)] ?? undefined;
  };
  const inRowFilter = (p: Permission, row: Rec): boolean =>
    Object.entries(p.rowFilter ?? {}).every(([f, v]) => {
      const val = filterValue(v);
      return val !== undefined && val !== null && row[f] === val;
    });
  const hiddenOf = (p: Permission) => new Set(p.hiddenFields ?? []);
  const strip = (p: Permission, row: Rec): Rec => {
    const h = hiddenOf(p);
    return Object.fromEntries(Object.entries(row).filter(([k]) => !h.has(k))) as Rec;
  };
  const failIf = (op: string) => {
    const i = failures.findIndex((f) => f.op === op);
    if (i >= 0) {
      const [f] = failures.splice(i, 1);
      throw f?.error;
    }
  };

  const matches = (row: Rec, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([f, cond]) => {
      const v = row[f];
      if (cond === null) return v === null || v === undefined;
      if (typeof cond !== "object" || Array.isArray(cond)) return v === cond;
      return Object.entries(cond as Record<string, unknown>).every(([op, x]) => {
        if (!OPS.has(op)) throw wzError("VALIDATION_FAILED");
        switch (op) {
          case "eq":
            return v === x;
          case "ne":
            return v !== x;
          case "lt":
            return cmp(v, x) < 0 && v != null;
          case "lte":
            return cmp(v, x) <= 0 && v != null;
          case "gt":
            return cmp(v, x) > 0 && v != null;
          case "gte":
            return cmp(v, x) >= 0 && v != null;
          case "in":
            return Array.isArray(x) && x.includes(v);
          default:
            return String(v ?? "")
              .toLowerCase()
              .includes(String(x).toLowerCase());
        }
      });
    });

  const validate = (e: Entity, p: Permission, values: Record<string, unknown>, isCreate: boolean) => {
    const fields = new Map(e.fields.map((f) => [f.name, f]));
    const hidden = hiddenOf(p);
    const forced = new Set(Object.keys(p.rowFilter ?? {}));
    for (const k of Object.keys(values)) {
      if ((SYSTEM as readonly string[]).includes(k))
        throw wzError("FIELD_READONLY", { fields: fe(k, "READONLY") });
      const f = fields.get(k);
      if (!f) throw wzError("UNKNOWN_FIELD", { fields: fe(k, "UNKNOWN") });
      if (hidden.has(k)) throw wzError("FIELD_HIDDEN", { fields: fe(k, "HIDDEN") });
      if (f.type === "qr_token" || p.readonlyFields?.includes(k))
        throw wzError("FIELD_READONLY", { fields: fe(k, "READONLY") });
    }
    const errors: { field: string; code: string; message: string }[] = [];
    for (const f of e.fields) {
      const has = Object.hasOwn(values, f.name);
      const v = values[f.name];
      const empty = v === undefined || v === null || v === "";
      if (
        isCreate &&
        f.required &&
        f.type !== "qr_token" &&
        empty &&
        f.default === undefined &&
        !forced.has(f.name)
      ) {
        errors.push({ field: f.name, code: "REQUIRED", message: ru.field.requiredError });
        continue;
      }
      if (!has || v === null || v === undefined || v === "") continue;
      const bad = fieldProblem(f, v, db);
      if (bad) errors.push({ field: f.name, code: "INVALID", message: bad });
    }
    if (errors.length) throw wzError("VALIDATION_FAILED", { fields: errors });
  };
  /** Consent when the written values contain a pii field and the role is not admin (ui-kit.yaml RecordForm.consent). */
  const needsConsent = (e: Entity, values: Record<string, unknown>) =>
    !isAdmin() && e.fields.some((f) => f.pii && f.pii !== "none" && Object.hasOwn(values, f.name));

  const store = {
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    version: () => version,
    latencyMs: opts.latencyMs ?? 0,
  };

  const ds: MemoryDataSource = {
    calls,
    outbox,
    getUser: () => current,
    version: () => version,
    setUser(id: string | null) {
      current = id ? (users.get(id) ?? null) : null;
      bump();
    },
    subscribe: store.subscribe,
    rows: (entity: string) => db.get(entity) ?? [],
    failNext(op: "create" | "update" | "remove" | "call" | "ai" | "pay", error: WzError) {
      failures.push({ op, error });
    },

    list(entity: string, q: ListQuery = {}) {
      const e = entityOf(entity);
      const p = perm(entity, "read");
      const hidden = hiddenOf(p);
      const filter = { ...(q.filter ?? {}) };
      if (q.search) {
        const f = e.fields.find((x) => x.type === "string" && !hidden.has(x.name));
        if (f) filter[f.name] = { contains: q.search };
      }
      for (const k of Object.keys(filter)) if (hidden.has(k)) throw wzError("FIELD_HIDDEN");
      if (q.sort && hidden.has(q.sort.field)) throw wzError("FIELD_HIDDEN");
      const pageSize = q.pageSize ?? 20;
      if (pageSize > 100) throw wzError("VALIDATION_FAILED");
      let rows = (db.get(entity) ?? []).filter((r) => inRowFilter(p, r) && matches(r, filter));
      const sort = q.sort ?? { field: "created_at", dir: "desc" as const };
      rows = [...rows].sort((a, b) => cmp(a[sort.field], b[sort.field]) * (sort.dir === "desc" ? -1 : 1));
      const page = Math.max(1, q.page ?? 1);
      return {
        items: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => strip(p, r)),
        total: rows.length,
      };
    },
    get(entity: string, id: string) {
      entityOf(entity);
      const p = perm(entity, "read");
      const row = (db.get(entity) ?? []).find((r) => r.id === id);
      if (!row || !inRowFilter(p, row)) throw wzError("NOT_FOUND");
      return withMeta(entity, strip(p, row));
    },
    runAi(action: string, entity: string, id: string) {
      calls.push({ op: "ai", entity, name: action, args: [id] });
      failIf("ai");
      const def = opts.aiActions?.[action];
      if (!def) throw wzError("NOT_FOUND", { message: "ИИ-действие не найдено" });
      if (def.entity !== entity) throw wzError("VALIDATION_FAILED");
      const p = perm(entity, "update");
      const row = (db.get(entity) ?? []).find((r) => r.id === id);
      if (!row || !inRowFilter(p, row)) throw wzError("NOT_FOUND");
      const values = def.fill({ ...row });
      const filled = Object.keys(values).filter((k) => values[k] !== undefined && values[k] !== null);
      for (const k of filled) row[k] = values[k];
      row.updated_at = now().toISOString();
      const key = `${entity}:${id}`;
      const marked = aiMeta.get(key) ?? new Set<string>();
      for (const k of filled) marked.add(k);
      aiMeta.set(key, marked);
      bump();
      return { item: ds.get(entity, id), filled, skipped: [] };
    },
    create(entity: string, values: Record<string, unknown>, o: WriteOpts = {}) {
      calls.push({ op: "create", entity, args: [values, o] });
      failIf("create");
      const e = entityOf(entity);
      const p = perm(entity, "create");
      validate(e, p, values, true);
      const row: Rec = {
        id: nextId(entity),
        created_at: now().toISOString(),
        updated_at: null,
        created_by: current?.id ?? null,
      };
      for (const f of e.fields) {
        if (f.type === "qr_token") row[f.name] = memoryQrToken(`${row.id}.${seq}`);
        else if (Object.hasOwn(values, f.name)) row[f.name] = values[f.name];
        else if (f.default !== undefined) row[f.name] = f.default;
      }
      for (const [f, v] of Object.entries(p.rowFilter ?? {})) {
        const val = filterValue(v);
        if (Object.hasOwn(values, f) && values[f] !== val) throw wzError("FORBIDDEN");
        row[f] = val;
      }
      if (needsConsent(e, values) && !o.consent) throw wzError("CONSENT_REQUIRED");
      db.get(entity)?.push(row);
      bump();
      return strip(p, row);
    },
    update(entity: string, id: string, patch: Record<string, unknown>, o: WriteOpts = {}) {
      calls.push({ op: "update", entity, args: [id, patch, o] });
      failIf("update");
      const e = entityOf(entity);
      const p = perm(entity, "update");
      const row = (db.get(entity) ?? []).find((r) => r.id === id);
      if (!row || !inRowFilter(p, row)) throw wzError("NOT_FOUND");
      validate(e, p, patch, false);
      if (needsConsent(e, patch) && !o.consent) throw wzError("CONSENT_REQUIRED");
      Object.assign(row, patch, { updated_at: now().toISOString() });
      // A user's write of an AI-filled field clears its mark (runtime: the _w_audit fold).
      for (const k of Object.keys(patch)) aiMeta.get(`${entity}:${id}`)?.delete(k);
      bump();
      return strip(p, row);
    },
    remove(entity: string, id: string) {
      calls.push({ op: "remove", entity, args: [id] });
      failIf("remove");
      const p = perm(entity, "delete");
      const rows = db.get(entity) ?? [];
      const i = rows.findIndex((r) => r.id === id && inRowFilter(p, r));
      if (i < 0) throw wzError("NOT_FOUND");
      rows.splice(i, 1);
      bump();
    },

    // ---------- hooks ----------
    useList<T>(entity: string, q: ListQuery): AsyncResult<{ items: T[]; total: number }> {
      return useComputed(store, `${entity}:${JSON.stringify(q)}`, () => ds.list(entity, q)) as AsyncResult<{
        items: T[];
        total: number;
      }>;
    },
    useRecord<T>(entity: string, id: string): AsyncResult<T> {
      return useComputed(store, `${entity}:${id}`, () => ds.get(entity, id)) as AsyncResult<T>;
    },
    useCreate(entity: string) {
      return useMutationState(async (values: Record<string, unknown>, o?: WriteOpts) =>
        ds.create(entity, values, o),
      );
    },
    useUpdate(entity: string) {
      return useMutationState(async (id: string, patch: Record<string, unknown>, o?: WriteOpts) =>
        ds.update(entity, id, patch, o),
      );
    },
    useRemove(entity: string) {
      return useMutationState(async (id: string) => ds.remove(entity, id));
    },
    useFn<T>(name: string, args?: unknown): AsyncResult<T> {
      return useComputed(store, `fn:${name}:${JSON.stringify(args)}`, () => {
        calls.push({ op: "fn", name, args: [args] });
        const fn = opts.functions?.[name];
        if (!fn) throw wzError("NOT_FOUND");
        return fn(args, { user: current, ds });
      }) as AsyncResult<T>;
    },
    useCall<R>() {
      return useMutationState(async (name: string, args: unknown, o?: WriteOpts) => {
        calls.push({ op: "call", name, args: [args, o] });
        failIf("call");
        const fn = opts.functions?.[name];
        if (!fn) throw wzError("NOT_FOUND");
        const r = fn(args, { user: current, ds }) as R;
        bump();
        return r;
      });
    },
    useUser(): UserResult {
      useSyncExternalStore(store.subscribe, store.version, store.version);
      return {
        user: current
          ? { id: current.id, role: current.role, displayName: current.displayName, isAdmin: current.isAdmin }
          : null,
        isLoading: false,
        login: (o = {}) => {
          const q = new URLSearchParams();
          if (o.role) q.set("role", o.role);
          if (o.next) q.set("next", o.next);
          const to = `/login${q.size ? `?${q}` : ""}`;
          if (opts.navigate) opts.navigate(to);
          else if (typeof window !== "undefined") {
            window.history.pushState(null, "", to);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
        },
        logout: async () => {
          current = null;
          bump();
        },
      };
    },
    useAuth(): AuthApi {
      return useMemo(() => auth, []);
    },
    useQrCheck() {
      return useCallback(async (req: QrCheckRequest) => qrCheck(req), []);
    },
    useQrOffline() {
      return useMemo(() => qrOffline, []);
    },
    useFiles() {
      return useMemo(() => files, []);
    },
    useAiAction() {
      return useMutationState(async (action: string, entity: string, id: string) =>
        ds.runAi(action, entity, id),
      );
    },
    usePay() {
      return useMutationState(async (integration: string, binding: string, id: string, token?: string) => {
        calls.push({ op: "pay", name: integration, args: [binding, id, token] });
        failIf("pay");
        const url = opts.pay?.({ integration, binding, id, ...(token ? { token } : {}) });
        return url ?? `/_wizard/pay-mock?${new URLSearchParams({ binding, id })}`;
      });
    },
    get files() {
      return files;
    },
    get auth() {
      return auth;
    },
    qrCheck: (req: QrCheckRequest) => qrCheck(req),
    get qrOffline() {
      return qrOffline;
    },
    qrCheckins: () => new Map(checkins),
  };

  const stored = new Map<string, FileInfo & { field: string; entity?: string }>();
  const images = new Map<string, string>(Object.entries(opts.images ?? {}));
  let fileSeq = 0;
  const files: MemoryDataSource["files"] = {
    async upload(file, target) {
      calls.push({ op: "files.upload", args: [file.name, target] });
      if (file.size > MAX_FILE_BYTES) throw wzError("PAYLOAD_TOO_LARGE", { message: ru.file.tooLarge });
      const mime = sniffFile(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
      if (!mime) throw wzError("UNSUPPORTED_MEDIA_TYPE");
      const fileId = `00000000-0000-4000-8000-${String(++fileSeq).padStart(12, "0")}`;
      const info: FileInfo = { fileId, name: file.name || "файл", size: file.size, mime };
      stored.set(fileId, { ...info, ...target });
      if (mime !== "application/pdf" && typeof URL.createObjectURL === "function")
        images.set(fileId, URL.createObjectURL(file));
      bump();
      return info;
    },
    async info(fileId) {
      const f = stored.get(fileId);
      if (!f) throw wzError("NOT_FOUND");
      return { fileId: f.fileId, name: f.name, size: f.size, mime: f.mime };
    },
    href: (fileId) => `/api/files/${encodeURIComponent(fileId)}`,
    imageSrc: (fileId, width) =>
      images.get(fileId) ?? `/api/files/${encodeURIComponent(fileId)}/img/${width}`,
    stored: () => new Map(stored),
  };

  const auth: AuthApi = {
    async start(channel, destination, o) {
      calls.push({ op: "auth.start", args: o?.role ? [channel, destination, o] : [channel, destination] });
      const code = String(100000 + ((seq++ * 7919 + 4243) % 900000));
      const msg = { channel, destination, code };
      outbox.push(msg);
      bump();
      const challengeId = `ch_${outbox.length}`;
      challenges.set(challengeId, msg);
      return { challengeId };
    },
    async verify(challengeId, code, consent) {
      const ch = challenges.get(challengeId);
      if (!ch || ch.code !== code) throw wzError("VALIDATION_FAILED", { message: ru.server.badCode });
      const known = [...users.values()].some(
        (x) => x[ch.channel === "phone" ? "phone" : "email"] === ch.destination,
      );
      if (opts.consentAtLogin && !known && !consent) throw wzError("CONSENT_REQUIRED");
      challenges.delete(challengeId);
      const key = ch.channel === "phone" ? "phone" : "email";
      let u = [...users.values()].find((x) => x[key] === ch.destination);
      if (!u) {
        const role = opts.signupRole ?? spec.roles.find((r) => r.selfSignup)?.name;
        if (!role) throw wzError("FORBIDDEN");
        u = { id: nextId("users"), role, displayName: ch.destination, isAdmin: false, [key]: ch.destination };
        users.set(u.id, u);
      }
      current = u;
      bump();
      return { id: u.id, role: u.role, displayName: u.displayName, isAdmin: u.isAdmin };
    },
    redirect() {
      const u = [...users.values()].find((x) =>
        spec.roles.some((r) => r.name === x.role && r.loginMethods?.includes("telegram")),
      );
      current = u ?? null;
      bump();
    },
  };

  const qrCarrier = () => {
    const qr = spec.integrations?.find((i) => i.connector === "qr")?.config as
      | { entity?: string; tokenField?: string; validStatuses?: string[]; displayFields?: string[] }
      | undefined;
    const e =
      spec.entities.find((x) => x.name === qr?.entity) ??
      spec.entities.find((x) => x.fields.some((f) => f.type === "qr_token"));
    const tokenField = qr?.tokenField ?? e?.fields.find((f) => f.type === "qr_token")?.name;
    const rows = e && tokenField ? (db.get(e.name) ?? []) : [];
    const title = (row: Rec) =>
      (qr?.displayFields ?? [])
        .map((f) => refCaption(spec, db, e as Entity, f, row[f]))
        .filter(Boolean)
        .join(" · ");
    return { qr, rows, tokenField: tokenField ?? "", title };
  };
  /** h → carrier row of every WZ1 token (offline package and sync). */
  const byHash = async () => {
    const c = qrCarrier();
    const out = new Map<string, Rec>();
    for (const row of c.rows) {
      const rand = typeof row[c.tokenField] === "string" ? payloadRand(row[c.tokenField] as string) : null;
      if (rand) out.set(await offlineHash(rand), row);
    }
    return { ...c, map: out };
  };
  const syncResults = new Map<string, QrSyncResult>();

  const qrOffline: QrOfflineApi = {
    async manifest(since) {
      calls.push({ op: "qrManifest", args: since ? [since] : [] });
      const c = await byHash();
      const entries: QrManifestEntry[] = [...c.map].map(([h, row]) => ({
        h,
        id: row.id,
        d: c.title(row),
        s: String(row.status ?? ""),
      }));
      const checkedIn = [...c.map]
        .filter(([, row]) => checkins.has(String(row[c.tokenField])))
        .map(([h]) => h);
      const at = now();
      return {
        manifestId: "memory",
        cursor: String(at.getTime()),
        generatedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + 72 * 3_600_000).toISOString(),
        full: true,
        validStatuses: c.qr?.validStatuses ?? [],
        entries,
        checkedIn,
        revoked: [],
      };
    },
    async sync(req) {
      calls.push({ op: "qrSync", args: [req] });
      const c = await byHash();
      const results: QrSyncResponse["results"] = req.events.map((ev) => {
        const known = syncResults.get(ev.clientEventId);
        if (known) return { clientEventId: ev.clientEventId, result: known };
        const row = c.map.get(ev.h);
        let result: QrSyncResult = "accepted";
        let firstScannedAt: string | undefined;
        if (!row) result = "unknown";
        else if (c.qr?.validStatuses && !c.qr.validStatuses.includes(String(row.status))) result = "revoked";
        else {
          const token = String(row[c.tokenField]);
          const first = checkins.get(token);
          if (first) {
            result = "duplicate";
            firstScannedAt = first.at < ev.scannedAt ? first.at : ev.scannedAt;
            first.at = firstScannedAt;
          } else checkins.set(token, { at: ev.scannedAt, ...(ev.gate ? { checkpoint: ev.gate } : {}) });
        }
        syncResults.set(ev.clientEventId, result);
        return { clientEventId: ev.clientEventId, result, ...(firstScannedAt ? { firstScannedAt } : {}) };
      });
      bump();
      const count = (r: QrSyncResult) => results.filter((x) => x.result === r).length;
      return {
        results,
        accepted: count("accepted"),
        duplicate: count("duplicate"),
        unknown: count("unknown"),
        revoked: count("revoked"),
        cursor: String(now().getTime()),
      };
    },
  };

  const qrCheck = (req: QrCheckRequest): QrCheckResponse => {
    calls.push({ op: "qrCheck", args: [req] });
    const scannedAt = now().toISOString();
    const c = qrCarrier();
    const qr = c.qr;
    const row = c.tokenField ? c.rows.find((r) => r[c.tokenField] === req.payload) : undefined;
    if (!row) return { status: "invalid", reason: "not_found", scannedAt };
    if (qr?.validStatuses && !qr.validStatuses.includes(String(row.status)))
      return { status: "invalid", reason: "not_valid_status", scannedAt };
    const title = c.title(row);
    const first = checkins.get(req.payload);
    if (first)
      return {
        status: "duplicate",
        scannedAt,
        firstScannedAt: first.at,
        ...(first.checkpoint ? { firstCheckpoint: first.checkpoint } : {}),
        ...(title ? { ticketTitle: title } : {}),
      };
    checkins.set(req.payload, { at: scannedAt, ...(req.checkpoint ? { checkpoint: req.checkpoint } : {}) });
    return { status: "ok", scannedAt, ...(title ? { ticketTitle: title } : {}) };
  };

  return ds;
}

function fe(field: string, code: string) {
  return [{ field, code, message: ru.server.notAllowedField }];
}

function refCaption(spec: AppSpec, db: Map<string, Rec[]>, e: Entity, field: string, v: unknown): string {
  const f = e.fields.find((x) => x.name === field);
  if (f?.type === "enum") return f.enum?.find((o) => o.value === v)?.label ?? String(v ?? "");
  if (f?.type !== "ref" || !f.ref) return v == null ? "" : String(v);
  const target = spec.entities.find((x) => x.name === f.ref?.entity);
  const tf = target?.fields.find((x) => x.type === "string")?.name;
  const row = (db.get(f.ref.entity) ?? []).find((r) => r.id === v);
  return tf && row ? String(row[tf] ?? "") : String(v ?? "");
}

/** Reactive read over the memory store; `latencyMs` delays the first result (loading state). */
function useComputed<T>(
  store: { subscribe(cb: () => void): () => void; version(): number; latencyMs: number },
  key: string,
  compute: () => T,
): AsyncResult<T> {
  const version = useSyncExternalStore(store.subscribe, store.version, store.version);
  const [tick, setTick] = useState(0);
  const latency = store.latencyMs;
  const [ready, setReady] = useState(latency === 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key restarts the simulated latency
  useEffect(() => {
    if (latency === 0) return;
    setReady(false);
    const t = setTimeout(() => setReady(true), latency);
    return () => clearTimeout(t);
  }, [key, latency]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed on store version, key and refetch tick
  const r = useMemo((): { data?: T; error?: WzError } => {
    try {
      return { data: compute() };
    } catch (e) {
      return { error: toWzError(e) };
    }
  }, [key, version, tick]);
  const refetch = useCallback(() => setTick((n) => n + 1), []);
  if (!ready) return { isLoading: true, refetch };
  return { ...r, isLoading: false, refetch };
}
