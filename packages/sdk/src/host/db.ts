// ctx.db / ctx.systemDb facade over a host DbAdapter: enforces sdk.md §2.1 limits, read-only mode for
// queries, system-field protection, and records `deps` (entities read by the call).
import { WizardError } from "../errors.js";
import type { PaginationOpts } from "../types.js";
import { SYSTEM_FIELD_NAMES } from "./indexes.js";

export type RawDoc = Record<string, unknown>;
export type RawWhere = Record<string, unknown>;
export interface RawListQuery {
  where?: RawWhere;
  order: "asc" | "desc";
  limit: number;
}
export interface RawPage {
  items: RawDoc[];
  continueCursor: string | null;
  isDone: boolean;
}

/**
 * Data access bound to one transaction and one subject. The runtime implements it with kysely + RLS
 * (permissions applied like the data API); `createTestHost` implements it in memory.
 * Errors are thrown as WizardError (FORBIDDEN, NOT_FOUND, VALIDATION_FAILED, CONFLICT, ...).
 */
export interface DbAdapter {
  get(entity: string, id: string): Promise<RawDoc | null>;
  getBy(entity: string, field: string, value: unknown): Promise<RawDoc | null>;
  list(entity: string, q: RawListQuery): Promise<RawDoc[]>;
  count(entity: string, where: RawWhere | undefined): Promise<number>;
  paginate(entity: string, q: Omit<RawListQuery, "limit">, page: PaginationOpts): Promise<RawPage>;
  insert(entity: string, doc: RawDoc): Promise<string>;
  patch(entity: string, id: string, patch: RawDoc): Promise<void>;
  delete(entity: string, id: string): Promise<void>;
}

export interface Limits {
  maxReads: number;
  maxWrites: number;
  listLimitWithWhere: number;
  listLimitWithoutWhere: number;
  maxPageItems: number;
  maxRunCalls: number;
  maxArgsBytes: number;
  maxResultBytes: number;
  maxDocBytes: number;
  queryTimeoutMs: number;
  mutationTimeoutMs: number;
  actionTimeoutMs: number;
}

/** sdk.md §2.1. */
export const DEFAULT_LIMITS: Limits = {
  maxReads: 4000,
  maxWrites: 500,
  listLimitWithWhere: 1000,
  listLimitWithoutWhere: 100,
  maxPageItems: 200,
  maxRunCalls: 20,
  maxArgsBytes: 1024 * 1024,
  maxResultBytes: 4 * 1024 * 1024,
  maxDocBytes: 1024 * 1024,
  queryTimeoutMs: 1000,
  mutationTimeoutMs: 1000,
  actionTimeoutMs: 30_000,
};

/** Per-call counters shared by ctx.db and ctx.systemDb. */
export class CallMeter {
  reads = 0;
  writes = 0;
  readonly deps = new Set<string>();
  constructor(readonly limits: Limits) {}

  read(entity: string, docs: number): void {
    this.deps.add(entity);
    this.reads += docs;
    if (this.reads > this.limits.maxReads) {
      throw new WizardError("LIMIT_EXCEEDED", {
        message: `Функция прочитала больше ${this.limits.maxReads} записей`,
        limit: "reads",
      });
    }
  }

  write(): void {
    this.writes += 1;
    if (this.writes > this.limits.maxWrites) {
      throw new WizardError("LIMIT_EXCEEDED", {
        message: `Функция записала больше ${this.limits.maxWrites} записей`,
        limit: "writes",
      });
    }
  }
}

const SYSTEM = new Set<string>(SYSTEM_FIELD_NAMES);

function jsonBytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v) ?? "").length;
}

function checkWritable(doc: unknown, meter: CallMeter): RawDoc {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new WizardError("VALIDATION_FAILED", { message: "Ожидается объект" });
  }
  const sys = Object.keys(doc).filter((k) => SYSTEM.has(k));
  if (sys.length > 0) {
    throw new WizardError("FIELD_READONLY", {
      message: "Системные поля нельзя изменить",
      fields: sys.map((field) => ({ field, code: "FIELD_READONLY", message: "Поле нельзя изменить" })),
    });
  }
  if (jsonBytes(doc) > meter.limits.maxDocBytes) {
    throw new WizardError("LIMIT_EXCEEDED", { message: "Запись больше 1 МиБ", limit: "doc_size" });
  }
  return doc as RawDoc;
}

function listLimit(meter: CallMeter, where: RawWhere | undefined, limit: number | undefined): number {
  const cap = where ? meter.limits.listLimitWithWhere : meter.limits.listLimitWithoutWhere;
  if (limit === undefined) return cap;
  if (!Number.isInteger(limit) || limit < 1 || limit > cap) {
    throw new WizardError("LIMIT_EXCEEDED", { message: `limit должен быть от 1 до ${cap}`, limit: "list" });
  }
  return limit;
}

function readOnlyError(): WizardError {
  return new WizardError("FORBIDDEN", { message: "Запись в query-функции запрещена" });
}

interface TableOptions {
  readOnly: boolean;
}

function table(adapter: DbAdapter, entity: string, meter: CallMeter, o: TableOptions) {
  const counted = async <T extends RawDoc | null>(p: Promise<T>): Promise<T> => {
    const doc = await p;
    meter.read(entity, doc ? 1 : 0);
    return doc;
  };
  return Object.freeze({
    get: (id: string) => counted(adapter.get(entity, id)),
    getBy: (field: string, value: unknown) => counted(adapter.getBy(entity, field, value)),
    list: async (opts: { where?: RawWhere; order?: "asc" | "desc"; limit?: number } = {}) => {
      const limit = listLimit(meter, opts.where, opts.limit);
      const docs = await adapter.list(entity, { where: opts.where, order: opts.order ?? "asc", limit });
      meter.read(entity, docs.length);
      return docs;
    },
    first: async (opts: { where?: RawWhere; order?: "asc" | "desc" } = {}) => {
      const docs = await adapter.list(entity, { where: opts.where, order: opts.order ?? "asc", limit: 1 });
      meter.read(entity, docs.length);
      return docs[0] ?? null;
    },
    count: async (opts: { where?: RawWhere } = {}) => {
      const n = await adapter.count(entity, opts.where);
      meter.read(entity, 1);
      return n;
    },
    paginate: async (opts: { where?: RawWhere; order?: "asc" | "desc" }, page: PaginationOpts) => {
      if (
        !Number.isInteger(page?.numItems) ||
        page.numItems < 1 ||
        page.numItems > meter.limits.maxPageItems
      ) {
        throw new WizardError("LIMIT_EXCEEDED", {
          message: `numItems должен быть от 1 до ${meter.limits.maxPageItems}`,
          limit: "paginate",
        });
      }
      const res = await adapter.paginate(entity, { where: opts?.where, order: opts?.order ?? "asc" }, page);
      meter.read(entity, res.items.length);
      return res;
    },
    insert: async (doc: unknown) => {
      if (o.readOnly) throw readOnlyError();
      const clean = checkWritable(doc, meter);
      meter.write();
      return adapter.insert(entity, clean);
    },
    patch: async (id: string, patch: unknown) => {
      if (o.readOnly) throw readOnlyError();
      const clean = checkWritable(patch, meter);
      meter.write();
      await adapter.patch(entity, id, clean);
    },
    delete: async (id: string) => {
      if (o.readOnly) throw readOnlyError();
      meter.write();
      await adapter.delete(entity, id);
    },
  });
}

/**
 * Builds `ctx.db` / `ctx.systemDb` for the given entity names. The result is structurally a
 * DbWriter (DbReader when readOnly) once the registry is augmented; callers cast it.
 */
export function createDbFacade(
  adapter: DbAdapter,
  entities: readonly string[],
  meter: CallMeter,
  o: TableOptions,
): Readonly<Record<string, ReturnType<typeof table>>> {
  const out: Record<string, ReturnType<typeof table>> = {};
  for (const e of entities) out[e] = table(adapter, e, meter, o);
  return Object.freeze(out);
}

export { jsonBytes };
