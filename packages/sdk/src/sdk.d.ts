// Handwritten public contract of @wizard/sdk = specs/runtime/sdk.md §5 (plus extensions marked "ext").
// G0 compiles system code against this file (sdk.md §1.1 tsconfig.system); src/index.ts binds every
// runtime export to the declarations below, so tsc keeps the implementation in sync with it.
// The registries are empty here and are filled by `_generated/wizard.d.ts` (module augmentation, §4).

// ---------- registries ----------
// Separate interfaces instead of one Register: function types and ctx would otherwise reference each other.
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated wizard.d.ts
export interface Entities {}
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated wizard.d.ts
export interface Roles {}
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated wizard.d.ts
export interface Functions {}
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated wizard.d.ts
export interface Connectors {}
// biome-ignore lint/suspicious/noEmptyInterface: augmented by generated wizard.d.ts
export interface Payments {}

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
declare const idBrand: unique symbol;
export type Id<E extends string> = string & { readonly [idBrand]: E };
export type EntityName = keyof Entities & string;
export type RoleName = keyof Roles & string;
export interface EntityShape {
  doc: object;
  insert: object;
  clientDoc: object;
  where: object;
  unique: string;
}
export type Ent<E extends EntityName> = Entities[E] extends EntityShape ? Entities[E] : never;
export type SystemFields<E extends string> = {
  id: Id<E>;
  created_at: string;
  updated_at: string | null;
  created_by: Id<"users"> | null;
};
export type Doc<E extends EntityName> = SystemFields<E> & Ent<E>["doc"];
export type ClientDoc<E extends EntityName> = SystemFields<E> & Ent<E>["clientDoc"];
export type Insert<E extends EntityName> = Ent<E>["insert"];
export type Patch<E extends EntityName> = Partial<Ent<E>["insert"]>;
export type Range<T> = { gt?: T; gte?: T; lt?: T; lte?: T };
export type IndexWhere<E extends EntityName> = Ent<E>["where"];

// ---------- validators ----------
export interface Validator<T> {
  readonly kind: string;
  readonly isOptional: boolean;
  readonly __t?: T;
}
export type Infer<V> = V extends Validator<infer T> ? T : never;
export type ArgsShape = Record<string, Validator<unknown>>;
type OptKeys<S extends ArgsShape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
export type InferArgs<S extends ArgsShape> = { [K in Exclude<keyof S, OptKeys<S>>]: Infer<S[K]> } & {
  [K in OptKeys<S>]?: Infer<S[K]>;
};
export interface PaginationOpts {
  cursor: string | null;
  numItems: number;
}
export declare const v: {
  string(o?: { min?: number; max?: number; pattern?: RegExp }): Validator<string>;
  int(o?: { min?: number; max?: number }): Validator<number>;
  number(o?: { min?: number; max?: number }): Validator<number>;
  money(o?: { min?: number; max?: number }): Validator<number>;
  boolean(): Validator<boolean>;
  date(): Validator<string>;
  datetime(): Validator<string>;
  email(): Validator<string>;
  phone(): Validator<string>;
  id<E extends EntityName | "users">(entity: E): Validator<Id<E>>;
  literal<const T extends string | number | boolean>(value: T): Validator<T>;
  enum<const T extends readonly [string, ...string[]]>(...values: T): Validator<T[number]>;
  array<T>(item: Validator<T>, o?: { max?: number }): Validator<T[]>;
  object<S extends ArgsShape>(shape: S): Validator<InferArgs<S>>;
  optional<T>(inner: Validator<T>): Validator<T | undefined>;
  nullable<T>(inner: Validator<T>): Validator<T | null>;
  pagination(): Validator<PaginationOpts>;
};

// ---------- data ----------
export interface ListOptions<E extends EntityName> {
  where?: IndexWhere<E>;
  order?: "asc" | "desc";
  limit?: number;
}
export interface Page<T> {
  items: T[];
  continueCursor: string | null;
  isDone: boolean;
}
export interface TableReader<E extends EntityName> {
  get(id: Id<E>): Promise<Doc<E> | null>;
  getBy<K extends Ent<E>["unique"] & keyof Doc<E>>(field: K, value: Doc<E>[K]): Promise<Doc<E> | null>;
  list(opts?: ListOptions<E>): Promise<Doc<E>[]>;
  first(opts?: Omit<ListOptions<E>, "limit">): Promise<Doc<E> | null>;
  count(opts?: { where?: IndexWhere<E> }): Promise<number>;
  paginate(opts: Omit<ListOptions<E>, "limit">, page: PaginationOpts): Promise<Page<Doc<E>>>;
}
export interface TableWriter<E extends EntityName> extends TableReader<E> {
  insert(doc: Insert<E>): Promise<Id<E>>;
  patch(id: Id<E>, patch: Patch<E>): Promise<void>;
  delete(id: Id<E>): Promise<void>;
}
export type DbReader = { readonly [E in EntityName]: TableReader<E> };
export type DbWriter = { readonly [E in EntityName]: TableWriter<E> };

// ---------- context ----------
export interface CurrentUser {
  id: Id<"users"> | null;
  role: RoleName | "__system";
  attrs: Readonly<Record<string, string | number | boolean>>;
  isAdmin: boolean;
}
export interface ErrorDetails {
  message?: string;
  [k: string]: Json | undefined;
}
export declare class WizardError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;
  /** ext: HTTP status when the error came from the runtime API (client side). */
  status?: number;
  constructor(code: string, details?: ErrorDetails);
}
export type LogFields = Record<string, number | boolean | null>;
export interface Logger {
  info(msg: string, f?: LogFields): void;
  warn(msg: string, f?: LogFields): void;
  error(msg: string, f?: LogFields): void;
}
export type JobId = string & { readonly __job: true };
export interface Scheduler {
  runAfter<N extends FunctionName>(delayMs: number, name: N, args: FnArgs<N>): Promise<JobId>;
  runAt<N extends FunctionName>(at: Date | string, name: N, args: FnArgs<N>): Promise<JobId>;
  cancel(id: JobId): Promise<void>;
}
export interface BaseCtx {
  user: CurrentUser;
  now: Date;
  error(code: string, details?: ErrorDetails): WizardError;
  log: Logger;
}
export interface QueryCtx extends BaseCtx {
  db: DbReader;
  systemDb: DbReader;
}
export interface MutationCtx extends BaseCtx {
  db: DbWriter;
  systemDb: DbWriter;
  scheduler: Scheduler;
}
export interface HttpResponseLike {
  status: number;
  text(): Promise<string>;
  json(): Promise<Json>;
}
export interface HttpClient {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<HttpResponseLike>;
}
export interface ActionCtx extends BaseCtx {
  scheduler: Scheduler;
  connectors: Connectors;
  http: HttpClient;
  runQuery<N extends QueryName>(name: N, args: FnArgs<N>): Promise<FnResult<N>>;
  runMutation<N extends MutationName>(name: N, args: FnArgs<N>): Promise<FnResult<N>>;
}

// ---------- function definitions ----------
export type FnKind = "query" | "mutation" | "action";
export interface FunctionDef<K extends FnKind, A, R> {
  readonly kind: K;
  readonly args: ArgsShape;
  readonly __a?: A;
  readonly __r?: R;
}
export type Def<S extends ArgsShape, C, R> = {
  args: S;
  handler: (ctx: C, args: InferArgs<S>) => R | Promise<R>;
};
export declare function query<S extends ArgsShape, R>(
  d: Def<S, QueryCtx, R>,
): FunctionDef<"query", InferArgs<S>, R>;
export declare function mutation<S extends ArgsShape, R>(
  d: Def<S, MutationCtx, R>,
): FunctionDef<"mutation", InferArgs<S>, R>;
export declare function action<S extends ArgsShape, R>(
  d: Def<S, ActionCtx, R>,
): FunctionDef<"action", InferArgs<S>, R>;

export type FunctionName = keyof Functions & string;
// `any` below: variance-free match on the function kind, as in sdk.md §5.
type NamesOf<K extends FnKind> = {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  [N in FunctionName]: Functions[N] extends FunctionDef<K, any, any> ? N : never;
}[FunctionName];
export type QueryName = NamesOf<"query">;
export type MutationName = NamesOf<"mutation">;
export type ActionName = NamesOf<"action">;
export type FnArgs<N extends FunctionName> =
  // biome-ignore lint/suspicious/noExplicitAny: see NamesOf
  Functions[N] extends FunctionDef<FnKind, infer A, any> ? A : never;
export type FnResult<N extends FunctionName> =
  // biome-ignore lint/suspicious/noExplicitAny: see NamesOf
  Functions[N] extends FunctionDef<FnKind, any, infer R> ? R : never;

// ---------- connectors (recipient addresses are resolved by the host) ----------
export interface TelegramConnector {
  sendToUser(i: {
    userId: Id<"users">;
    text: string;
    buttons?: { text: string; url: string }[];
    idempotencyKey?: string;
  }): Promise<{ delivered: boolean; reason?: "not_linked" | "blocked" | "test_mode" }>;
}
export interface EmailConnector {
  sendTemplate(i: {
    userId: Id<"users">;
    template: string;
    params: Record<string, string | number>;
    attachQrOf?: { entity: EntityName; id: string };
    idempotencyKey?: string;
  }): Promise<{ messageId: string }>;
}
export interface YookassaConnector {
  refund(i: {
    binding: string;
    id: string;
    amount?: number;
    reason?: string;
    idempotencyKey?: string;
  }): Promise<{ refundId: string; status: "pending" | "succeeded" | "canceled" }>;
  getPaymentStatus(i: {
    binding: string;
    id: string;
  }): Promise<"none" | "pending" | "waiting_for_capture" | "succeeded" | "canceled">;
}
export interface QrConnector {
  revoke(i: { entity: EntityName; id: string }): Promise<void>;
}

// ---------- client ----------
export interface QueryState<T> {
  data: T | undefined;
  error: WizardError | undefined;
  isLoading: boolean;
  refetch(): void;
}
/** SDK adds `_consent` to the request body (security/compliance.yaml#consent). */
export interface CallOptions {
  consent?: true;
}
export type FilterOps<T> = {
  eq?: T;
  ne?: T;
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
  in?: T[];
  contains?: string;
};
export type EntityFilter<E extends EntityName> = {
  [K in keyof ClientDoc<E>]?: ClientDoc<E>[K] | FilterOps<ClientDoc<E>[K]>;
};
export type SortKey<E extends EntityName> = (keyof ClientDoc<E> & string) | `-${keyof ClientDoc<E> & string}`;
export interface EntityListOptions<E extends EntityName> {
  filter?: EntityFilter<E>;
  sort?: SortKey<E> | SortKey<E>[];
  page?: number;
  limit?: number;
}
export interface EntityListState<E extends EntityName> {
  items: ClientDoc<E>[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  isLoading: boolean;
  error: WizardError | undefined;
  refetch(): void;
}
export interface EntityMutations<E extends EntityName> {
  create(doc: Insert<E>, opts?: CallOptions): Promise<ClientDoc<E>>;
  /** `opts.consent`: extension of sdk.md §5 — runtime requires `_consent` on update of pii rows too. */
  update(id: Id<E> | string, patch: Patch<E>, opts?: CallOptions): Promise<ClientDoc<E>>;
  remove(id: Id<E> | string): Promise<void>;
}
export interface ClientUser {
  id: Id<"users">;
  role: RoleName;
  displayName: string;
  isAdmin: boolean;
}
export interface UserState {
  user: ClientUser | null;
  isLoading: boolean;
  login(o?: { role?: RoleName; next?: string }): void;
  logout(): Promise<void>;
}
/** Result of an AI action: the record with `_aiFilled` (fields whose last write was the AI) and what was filled. */
export interface AiActionResult<E extends EntityName = EntityName> {
  item: ClientDoc<E> & { _aiFilled: string[] };
  filled: string[];
  skipped: string[];
}
export interface AiActionState {
  run<E extends EntityName>(entity: E, id: Id<E> | string): Promise<AiActionResult<E>>;
  pending: boolean;
  error: WizardError | undefined;
}
export interface PaymentState<I extends keyof Payments & string> {
  pay(binding: Payments[I], id: string): Promise<void>;
  pending: boolean;
  error: WizardError | undefined;
}

export declare function useQuery<N extends QueryName>(
  name: N,
  args: FnArgs<N> | "skip",
): QueryState<FnResult<N>>;
export declare function useMutation<N extends MutationName | ActionName>(
  name: N,
): [
  (args: FnArgs<N>, opts?: CallOptions) => Promise<FnResult<N>>,
  { pending: boolean; error: WizardError | undefined },
];
export declare function useEntityList<E extends EntityName>(
  entity: E,
  opts?: EntityListOptions<E>,
): EntityListState<E>;
export declare function useEntity<E extends EntityName>(
  entity: E,
  id: Id<E> | string | undefined,
): QueryState<ClientDoc<E> | null>;
export declare function useEntityMutation<E extends EntityName>(entity: E): EntityMutations<E>;
export declare function useUser(): UserState;
export declare function usePayment<I extends keyof Payments & string>(integration: I): PaymentState<I>;
/** M3-02: AI action of the spec (aiActions[].name) — POST /api/ai/:action (runtime.yaml#ai_actions). */
export declare function useAiAction(action: string): AiActionState;
export declare function useParams<T extends Record<string, string> = Record<string, string>>(): T;
export declare function useNavigate(): (to: string) => void;
export { useCallback, useEffect, useMemo, useRef, useState } from "react";
