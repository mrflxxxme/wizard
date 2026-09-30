// In-memory DbAdapter + TransactionRunner: same permission semantics as the data API
// (runtime.yaml#permissions) so functions can be unit-tested without Postgres.
import { type AppSpec, DEFAULT_MAX_LENGTH, type Entity, type Field } from "@wizard/appspec";
import { WizardError } from "../errors.js";
import type { DbAdapter, RawDoc, RawListQuery, RawPage, RawWhere } from "../host/db.js";
import type {
  ScheduledJob,
  SchedulerAdapter,
  TransactionRunner,
  TxContext,
  TxMode,
} from "../host/executor.js";
import { isRangeValue, resolveIndex, SYSTEM_FIELD_NAMES, uniqueFields } from "../host/indexes.js";
import {
  type AccessPolicy,
  type AccessSubject,
  compilePolicy,
  type PermissionOp,
  rowMatches,
  SYSTEM_ROLE,
  stripHidden,
} from "../host/permissions.js";
import type { CurrentUser, PaginationOpts } from "../sdk.js";

export interface InvalidateEvent {
  entity: string;
  id?: string;
  op: "insert" | "update" | "delete";
}

export interface StoredJob extends ScheduledJob {
  id: string;
}

export interface MemState {
  tables: Map<string, Map<string, RawDoc>>;
  jobs: Map<string, StoredJob>;
}

/** Full `users` rows (system entity, runtime.yaml#postgres.system_tables); contacts visible to the host only. */
export type UserRecord = Record<string, unknown> & { id: string; role: string };

function cloneState(s: MemState): MemState {
  const tables = new Map<string, Map<string, RawDoc>>();
  for (const [k, v] of s.tables) tables.set(k, new Map(v));
  return { tables, jobs: new Map(s.jobs) };
}

/** Monotonic uuid-shaped ids: lexicographic order = creation order (deterministic tests). */
export function createIdGenerator(): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    const hex = seq.toString(16).padStart(12, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${"0".repeat(12)}`;
  };
}

const SYSTEM_FIELDS = new Set<string>(SYSTEM_FIELD_NAMES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9()\-\s]{7,20}$/;

function fieldError(
  code: string,
  message: string,
  fields: { field: string; code: string; message: string }[],
) {
  return new WizardError(code, { message, fields });
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchesWhere(row: RawDoc, where: RawWhere | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (isRangeValue(cond)) {
      if (v === null || v === undefined) return false;
      if (cond.gt !== undefined && !(cmp(v, cond.gt) > 0)) return false;
      if (cond.gte !== undefined && !(cmp(v, cond.gte) >= 0)) return false;
      if (cond.lt !== undefined && !(cmp(v, cond.lt) < 0)) return false;
      if (cond.lte !== undefined && !(cmp(v, cond.lte) <= 0)) return false;
      return true;
    }
    if (cond === null) return v === null || v === undefined;
    return v !== null && v !== undefined && String(v) === String(cond);
  });
}

export interface MemoryDbOptions {
  spec: AppSpec;
  state: MemState;
  subject: AccessSubject;
  now: Date;
  newId: () => string;
  users: ReadonlyMap<string, UserRecord>;
  /** Invalidation events of this transaction (published by the runner after commit). */
  events: InvalidateEvent[];
  /** Guards writes after the transaction ended (e.g. a timed-out handler still running). */
  isOpen: () => boolean;
}

export class MemoryDb implements DbAdapter {
  private readonly policies = new Map<string, AccessPolicy>();
  constructor(private readonly o: MemoryDbOptions) {}

  private entity(name: string): Entity {
    const e = this.o.spec.entities.find((x) => x.name === name);
    if (!e) throw new WizardError("NOT_FOUND", { message: `Сущность ${name} не найдена` });
    return e;
  }

  private table(name: string): Map<string, RawDoc> {
    let t = this.o.state.tables.get(name);
    if (!t) {
      t = new Map();
      this.o.state.tables.set(name, t);
    }
    return t;
  }

  private policy(entity: string): AccessPolicy {
    let p = this.policies.get(entity);
    if (!p) {
      p = compilePolicy(this.o.spec, entity, this.o.subject);
      this.policies.set(entity, p);
    }
    return p;
  }

  private require(entity: string, op: PermissionOp): AccessPolicy {
    this.entity(entity);
    const p = this.policy(entity);
    if (!p.allows(op)) throw new WizardError("FORBIDDEN");
    return p;
  }

  private visible(row: RawDoc | undefined, p: AccessPolicy, op: PermissionOp): row is RawDoc {
    return row !== undefined && rowMatches(row, p.rowConstraint(op));
  }

  private checkHiddenKeys(keys: Iterable<string>, p: AccessPolicy): void {
    const hidden = [...keys].filter((k) => p.hidden.has(k));
    if (hidden.length > 0) {
      throw fieldError(
        "FIELD_HIDDEN",
        "Поле недоступно",
        hidden.map((field) => ({ field, code: "FIELD_HIDDEN", message: "Поле недоступно" })),
      );
    }
  }

  private checkWhere(entity: Entity, where: RawWhere | undefined, p: AccessPolicy): string[] | undefined {
    if (!where) return undefined;
    const keys = Object.keys(where);
    if (keys.length === 0) return undefined;
    this.checkHiddenKeys(keys, p);
    const idx = resolveIndex(entity, keys);
    if (!idx) {
      throw new WizardError("VALIDATION_FAILED", {
        message: "Условие where должно совпадать с префиксом индекса",
        fields: keys.map((field) => ({ field, code: "NOT_INDEXED", message: "Нет подходящего индекса" })),
      });
    }
    const ranges = keys.filter((k) => isRangeValue(where[k]));
    const last = idx[keys.length - 1];
    if (ranges.length > 1 || (ranges.length === 1 && ranges[0] !== last)) {
      throw new WizardError("VALIDATION_FAILED", {
        message: "Диапазон допустим только в последнем поле индекса",
      });
    }
    return idx;
  }

  private select(entity: string, where: RawWhere | undefined, order: "asc" | "desc"): RawDoc[] {
    const e = this.entity(entity);
    const p = this.require(entity, "read");
    const idx = this.checkWhere(e, where, p) ?? [];
    const sortKeys = [...idx.filter((f) => f !== "created_at" && f !== "id"), "created_at", "id"];
    const dir = order === "desc" ? -1 : 1;
    return [...this.table(entity).values()]
      .filter((r) => this.visible(r, p, "read") && matchesWhere(r, where))
      .sort((a, b) => {
        for (const k of sortKeys) {
          const c = cmp(a[k], b[k]);
          if (c !== 0) return c * dir;
        }
        return 0;
      })
      .map((r) => stripHidden(r, p.hidden));
  }

  async get(entity: string, id: string): Promise<RawDoc | null> {
    const p = this.require(entity, "read");
    const row = this.table(entity).get(String(id));
    return this.visible(row, p, "read") ? stripHidden(row, p.hidden) : null;
  }

  async getBy(entity: string, field: string, value: unknown): Promise<RawDoc | null> {
    const e = this.entity(entity);
    const p = this.require(entity, "read");
    if (!uniqueFields(e).includes(field)) {
      throw new WizardError("VALIDATION_FAILED", { message: `Поле ${field} не уникальное` });
    }
    this.checkHiddenKeys([field], p);
    for (const row of this.table(entity).values()) {
      if (row[field] !== null && String(row[field]) === String(value)) {
        return this.visible(row, p, "read") ? stripHidden(row, p.hidden) : null;
      }
    }
    return null;
  }

  async list(entity: string, q: RawListQuery): Promise<RawDoc[]> {
    return this.select(entity, q.where, q.order).slice(0, q.limit);
  }

  async count(entity: string, where: RawWhere | undefined): Promise<number> {
    return this.select(entity, where, "asc").length;
  }

  async paginate(entity: string, q: Omit<RawListQuery, "limit">, page: PaginationOpts): Promise<RawPage> {
    const all = this.select(entity, q.where, q.order);
    const start = page.cursor ? Number.parseInt(page.cursor, 10) : 0;
    if (!Number.isInteger(start) || start < 0)
      throw new WizardError("VALIDATION_FAILED", { message: "Неверный курсор" });
    const end = start + page.numItems;
    const isDone = end >= all.length;
    return { items: all.slice(start, end), continueCursor: isDone ? null : String(end), isDone };
  }

  private ensureOpen(): void {
    if (!this.o.isOpen()) throw new WizardError("INTERNAL", { message: "Транзакция уже завершена" });
  }

  /** Type/format checks for one field value; returns the normalized value. */
  private normalize(
    entity: Entity,
    f: Field,
    value: unknown,
    issues: { field: string; code: string; message: string }[],
    p: AccessPolicy,
  ): unknown {
    const bad = (code: string, message: string) => {
      issues.push({ field: f.name, code, message });
      return value;
    };
    if (value === null || value === undefined) {
      return f.required ? bad("required", "Обязательное поле") : null;
    }
    switch (f.type) {
      case "string":
      case "text":
      case "email":
      case "phone":
      case "url":
      case "file":
      case "qr_token": {
        if (typeof value !== "string") return bad("type", "Ожидается строка");
        const max = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type];
        if (max !== undefined && [...value].length > max)
          return bad("maxLength", `Максимум символов: ${max}`);
        if (f.required && value.trim() === "") return bad("required", "Обязательное поле");
        if (f.type === "email" && !EMAIL_RE.test(value)) return bad("format", "Неверный email");
        if (f.type === "phone") {
          if (!PHONE_RE.test(value)) return bad("format", "Неверный номер телефона");
          return value.replace(/[^0-9+]/g, "");
        }
        return value;
      }
      case "int":
      case "decimal":
      case "money": {
        if (typeof value !== "number" || !Number.isFinite(value)) return bad("type", "Ожидается число");
        if (f.type === "int" && !Number.isInteger(value)) return bad("type", "Ожидается целое число");
        if (f.type === "money" && Math.round(value * 100) !== value * 100) {
          return bad("type", "Не больше 2 знаков после запятой");
        }
        if (f.min !== undefined && value < f.min) return bad("min", `Не меньше ${f.min}`);
        if (f.max !== undefined && value > f.max) return bad("max", `Не больше ${f.max}`);
        return value;
      }
      case "bool":
        return typeof value === "boolean" ? value : bad("type", "Ожидается да/нет");
      case "date":
        return typeof value === "string" && DATE_RE.test(value) && !Number.isNaN(Date.parse(value))
          ? value
          : bad("type", "Ожидается дата ГГГГ-ММ-ДД");
      case "datetime": {
        const d = typeof value === "string" || value instanceof Date ? new Date(value) : undefined;
        return d && !Number.isNaN(d.getTime()) ? d.toISOString() : bad("type", "Ожидается дата и время");
      }
      case "enum":
        return typeof value === "string" && (f.enum ?? []).some((o) => o.value === value)
          ? value
          : bad("enum", "Недопустимое значение");
      case "ref": {
        const target = f.ref?.entity ?? "";
        const id = String(value);
        if (target === "users") {
          return this.o.users.has(id) ? id : bad("ref", "Пользователь не найден");
        }
        const row = this.table(target).get(id);
        if (!row) return bad("ref", "Связанная запись не найдена");
        if (!p.system) {
          const tp = this.policy(target);
          if (!tp.allows("read") || !this.visible(row, tp, "read"))
            return bad("ref", "Связанная запись не найдена");
        }
        return id;
      }
      case "json":
        try {
          JSON.stringify(value);
          return value;
        } catch {
          return bad("type", "Ожидается JSON");
        }
    }
    void entity;
    return value;
  }

  private checkUnique(entity: Entity, row: RawDoc, selfId: string | undefined): void {
    const groups: string[][] = [
      ...entity.fields.filter((f) => f.unique).map((f) => [f.name]),
      ...(entity.indexes ?? []).filter((i) => i.unique).map((i) => i.fields),
    ];
    for (const fields of groups) {
      if (fields.some((f) => row[f] === null || row[f] === undefined)) continue;
      for (const other of this.table(entity.name).values()) {
        if (other.id === selfId) continue;
        if (fields.every((f) => String(other[f]) === String(row[f]))) {
          throw fieldError(
            "CONFLICT",
            "Такое значение уже есть",
            fields.map((field) => ({ field, code: "unique", message: "Такое значение уже есть" })),
          );
        }
      }
    }
  }

  private checkKeys(entity: Entity, doc: RawDoc, p: AccessPolicy): void {
    const known = new Set(entity.fields.map((f) => f.name));
    const unknown = Object.keys(doc).filter((k) => !known.has(k) && !SYSTEM_FIELDS.has(k));
    if (unknown.length > 0) {
      throw fieldError(
        "UNKNOWN_FIELD",
        "Такого поля нет",
        unknown.map((field) => ({ field, code: "UNKNOWN_FIELD", message: "Такого поля нет" })),
      );
    }
    const sys = Object.keys(doc).filter((k) => SYSTEM_FIELDS.has(k));
    // qr_token values are generated by the host (runtime.yaml#data_api.writes); subjects cannot set them.
    const qr = new Set(entity.fields.filter((f) => f.type === "qr_token").map((f) => f.name));
    const ro = Object.keys(doc).filter((k) => p.readonly.has(k) || (!p.system && qr.has(k)));
    if (sys.length + ro.length > 0) {
      throw fieldError(
        "FIELD_READONLY",
        "Поле нельзя изменить",
        [...sys, ...ro].map((field) => ({ field, code: "FIELD_READONLY", message: "Поле нельзя изменить" })),
      );
    }
    this.checkHiddenKeys(Object.keys(doc), p);
  }

  async insert(entity: string, doc: RawDoc): Promise<string> {
    this.ensureOpen();
    const e = this.entity(entity);
    const p = this.require(entity, "create");
    this.checkKeys(e, doc, p);
    const input: RawDoc = { ...doc };
    const c = p.rowConstraint("create");
    if (c === false) throw new WizardError("FORBIDDEN");
    for (const [col, v] of Object.entries(c ?? {})) {
      if (input[col] !== undefined && input[col] !== null && String(input[col]) !== String(v)) {
        throw new WizardError("FORBIDDEN");
      }
      input[col] = v;
    }
    const issues: { field: string; code: string; message: string }[] = [];
    const row: RawDoc = {
      id: this.o.newId(),
      created_at: this.o.now.toISOString(),
      updated_at: null,
      created_by: this.o.subject.role === SYSTEM_ROLE ? null : this.o.subject.id,
    };
    for (const f of e.fields) {
      let value = input[f.name];
      if ((value === undefined || value === null) && f.default !== undefined) value = f.default;
      if ((value === undefined || value === null) && f.type === "qr_token") value = randomToken();
      row[f.name] = this.normalize(e, f, value, issues, p);
    }
    if (issues.length > 0) throw fieldError("VALIDATION_FAILED", "Проверьте заполнение полей", issues);
    this.checkUnique(e, row, undefined);
    this.table(entity).set(row.id as string, row);
    this.o.events.push({ entity, id: row.id as string, op: "insert" });
    return row.id as string;
  }

  async patch(entity: string, id: string, patch: RawDoc): Promise<void> {
    this.ensureOpen();
    const e = this.entity(entity);
    const p = this.require(entity, "update");
    const current = this.table(entity).get(String(id));
    if (!this.visible(current, p, "update")) throw new WizardError("NOT_FOUND");
    this.checkKeys(e, patch, p);
    const issues: { field: string; code: string; message: string }[] = [];
    const next: RawDoc = { ...current };
    for (const f of e.fields) {
      if (Object.hasOwn(patch, f.name) && patch[f.name] !== undefined) {
        next[f.name] = this.normalize(e, f, patch[f.name], issues, p);
      }
    }
    if (issues.length > 0) throw fieldError("VALIDATION_FAILED", "Проверьте заполнение полей", issues);
    // WITH CHECK: the updated row must stay inside the role's rowFilter.
    if (!rowMatches(next, p.rowConstraint("update"))) throw new WizardError("FORBIDDEN");
    this.checkUnique(e, next, current.id as string);
    next.updated_at = this.o.now.toISOString();
    this.table(entity).set(current.id as string, next);
    this.o.events.push({ entity, id: current.id as string, op: "update" });
  }

  async delete(entity: string, id: string): Promise<void> {
    this.ensureOpen();
    this.entity(entity);
    const p = this.require(entity, "delete");
    const current = this.table(entity).get(String(id));
    if (!this.visible(current, p, "delete")) throw new WizardError("NOT_FOUND");
    this.removeRow(entity, current.id as string);
  }

  private removeRow(entity: string, id: string): void {
    for (const other of this.o.spec.entities) {
      for (const f of other.fields) {
        if (f.type !== "ref" || f.ref?.entity !== entity) continue;
        const action = f.ref.onDelete ?? "restrict";
        for (const row of [...this.table(other.name).values()]) {
          if (String(row[f.name]) !== id) continue;
          if (action === "restrict") {
            throw new WizardError("CONFLICT", {
              message: "На запись ссылаются другие записи",
              entity: other.name,
            });
          }
          if (action === "cascade") this.removeRow(other.name, row.id as string);
          else {
            this.table(other.name).set(row.id as string, { ...row, [f.name]: null });
            this.o.events.push({ entity: other.name, id: row.id as string, op: "update" });
          }
        }
      }
    }
    this.table(entity).delete(id);
    this.o.events.push({ entity, id, op: "delete" });
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

export interface MemoryTransactionsOptions {
  spec: AppSpec;
  clock: () => Date;
  newId: () => string;
  users: ReadonlyMap<string, UserRecord>;
  onCommit?: (events: InvalidateEvent[]) => void;
}

/**
 * Read transactions see the last committed snapshot; write transactions run one at a time on a copy
 * that replaces the committed state on success (trivially SERIALIZABLE), and are dropped on error.
 */
export class MemoryTransactions implements TransactionRunner {
  state: MemState = { tables: new Map(), jobs: new Map() };
  private lock: Promise<void> = Promise.resolve();
  constructor(private readonly o: MemoryTransactionsOptions) {}

  private subject(user: CurrentUser): AccessSubject {
    const id = user.id === null ? null : String(user.id);
    return { id, role: user.role, record: id === null ? undefined : this.o.users.get(id) };
  }

  private tx(
    state: MemState,
    user: CurrentUser,
    events: InvalidateEvent[],
    isOpen: () => boolean,
  ): TxContext {
    const now = this.o.clock();
    const base = { spec: this.o.spec, state, now, newId: this.o.newId, users: this.o.users, events, isOpen };
    const scheduler: SchedulerAdapter = {
      enqueue: async (job) => {
        if (!isOpen()) throw new WizardError("INTERNAL", { message: "Транзакция уже завершена" });
        const id = this.o.newId();
        state.jobs.set(id, { ...job, id });
        return id;
      },
      cancel: async (id) => {
        state.jobs.delete(id);
      },
    };
    return {
      db: new MemoryDb({ ...base, subject: this.subject(user) }),
      systemDb: new MemoryDb({ ...base, subject: { id: null, role: SYSTEM_ROLE } }),
      scheduler,
      now,
    };
  }

  async run<T>(mode: TxMode, user: CurrentUser, fn: (tx: TxContext) => Promise<T>): Promise<T> {
    if (mode === "read") {
      // Writes through a read transaction are rejected by the facade; the snapshot is never mutated
      // because write transactions work on copies.
      return fn(this.tx(this.state, user, [], () => false));
    }
    const prev = this.lock;
    let release = () => {};
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    let open = true;
    try {
      const working = cloneState(this.state);
      const events: InvalidateEvent[] = [];
      const result = await fn(this.tx(working, user, events, () => open));
      open = false;
      this.state = working;
      if (events.length > 0) this.o.onCommit?.(events);
      return result;
    } finally {
      open = false;
      release();
    }
  }
}
