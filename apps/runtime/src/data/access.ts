// DataAccess — the single entry point for the data API (/api/data/:entity) and for ctx.db / ctx.systemDb of
// system functions (architecture.yaml#interfaces.data_access). Semantics: runtime.yaml#data_api, #permissions,
// #postgres.context; sdk.md §2.2–2.4. M0-09 implements it over Postgres (./pg.ts); M0-23 builds /api/fn on it.
import type { AppSpec } from "@wizard/appspec";
import type { DbAdapter, SchedulerAdapter, TransactionRunner, TxMode } from "@wizard/sdk/host";
import type postgres from "postgres";

export type { DbAdapter, SchedulerAdapter, TransactionRunner, TxMode };

/** Role name of system access (ctx.systemDb, workflows, scheduler): runtime.yaml#postgres.context. */
export const SYSTEM_ROLE = "__system";

export type DataOp = "read" | "create" | "update" | "delete";

/** Who performs an operation (runtime.yaml#permissions.algorithm, step 1). */
export interface Subject {
  /** users.id; null for the public role and for `__system`. */
  id: string | null;
  /** Role name from the spec or `__system`. */
  role: string;
  isAdmin: boolean;
  /** Row of the system `users` table: source of `$user.<attr>` and `wizard.user_attrs`. Never sent to clients. */
  record: Readonly<Record<string, unknown>>;
}

/** Document as returned to clients: {id, created_at, updated_at, created_by, ...visible fields}. */
export type Doc = Record<string, unknown>;

export type FilterOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "contains";

/** One `filter[<field>][<op>]=<value>` condition; `null` → IS NULL (eq) / IS NOT NULL (ne). */
export interface FilterCond {
  field: string;
  op: FilterOp;
  value: string | readonly string[] | null;
}

export interface SortKey {
  field: string;
  dir: "asc" | "desc";
}

/** Parsed query of GET /api/data/:entity (runtime.yaml#data_api.query_params). */
export interface ListQuery {
  filter: readonly FilterCond[];
  sort: readonly SortKey[];
  page: number;
  limit: number;
  /** `q`: search over the role's readable text, phone and int fields (V3-18). */
  search?: string;
}

export interface ListResult {
  items: Doc[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  totalCapped?: true;
}

/** `_consent` of create/update bodies (security/compliance.yaml#consent). */
export interface ConsentInput {
  policyVersion: string;
  textHash: string;
}

export interface WriteOptions {
  consent?: ConsentInput;
  /** Set by the server (never the client): HMAC of the client network for the consent journal (_w_consents). */
  ipHmac?: Uint8Array | null;
}

/** runtime.yaml#realtime.event; published only after commit, never with field values. */
export interface InvalidationEvent {
  entity: string;
  id: string;
  op: "insert" | "update" | "delete";
}

/** In-process bus (M0): subscribers receive events after the writing transaction committed. */
export interface InvalidationBus {
  publish(events: readonly InvalidationEvent[]): void;
  subscribe(listener: (e: InvalidationEvent) => void): () => void;
}

/**
 * Handles valid inside one transaction with the RLS context already set (set_config(..., true)).
 * `data` applies the subject's permissions like the data API; `system` acts as `__system`.
 */
export interface DataTx {
  readonly subject: Subject;
  /** Transaction start time (ctx.now). */
  readonly now: Date;
  readonly data: DbAdapter;
  readonly system: DbAdapter;
  readonly scheduler: SchedulerAdapter;
  /**
   * Raw SQL inside the same transaction (fully qualified names only; AGENTS.md). It runs with the RLS context of
   * the last `data`/`system` call (initially the subject's); open the transaction with SYSTEM_SUBJECT for system work.
   */
  readonly sql: postgres.TransactionSql;
  /** Queue an invalidation event; published after commit. */
  invalidate(e: InvalidationEvent): void;
}

export interface DataAccess {
  readonly spec: AppSpec;
  /** Postgres schema of the system: app_<systemKey>_<env>. */
  readonly schema: string;
  readonly events: InvalidationBus;

  // ---------- data API (each call is one transaction; errors are WizardError) ----------
  list(subject: Subject, entity: string, q: ListQuery): Promise<ListResult>;
  get(subject: Subject, entity: string, id: string): Promise<Doc>;
  create(subject: Subject, entity: string, body: unknown, o?: WriteOptions): Promise<Doc>;
  update(subject: Subject, entity: string, id: string, body: unknown, o?: WriteOptions): Promise<Doc>;
  remove(subject: Subject, entity: string, id: string): Promise<void>;

  // ---------- functions and internal callers ----------
  /** read → REPEATABLE READ READ ONLY, write → SERIALIZABLE (sdk.md §2.2), default → READ COMMITTED; rolls back on reject. */
  transaction<T>(mode: TxMode | "default", subject: Subject, fn: (tx: DataTx) => Promise<T>): Promise<T>;
  /** TransactionRunner for createFunctionHost (@wizard/sdk/host); loads the users row of CurrentUser. */
  runner(): TransactionRunner;
  /** Subject for a row of `users` (isAdmin from the spec role). */
  subjectFor(user: Readonly<Record<string, unknown>>): Subject;
  /** Subject of the public role, or null when the spec has none (→ 401). */
  publicSubject(): Subject | null;
}

/** Subject used by ctx.systemDb, workflows and the scheduler. */
export const SYSTEM_SUBJECT: Subject = Object.freeze({
  id: null,
  role: SYSTEM_ROLE,
  isAdmin: false,
  record: Object.freeze({}),
});
