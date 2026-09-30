// sdkDataSource(): DataSource over @wizard/sdk client hooks (ui-kit.yaml#data_binding.sdk_mapping).
import {
  useEntity,
  useEntityList,
  useEntityMutation,
  useMutation,
  useQuery,
  useSdkClient,
  useUser,
  type WizardError,
} from "@wizard/sdk";
import { useMemo } from "react";
import { useRoleSpec } from "./context.js";
import { toWzError, useMutationState } from "./mutation.js";
import { titleField } from "./roleSpec.js";
import type {
  AsyncResult,
  AuthApi,
  DataSource,
  ListQuery,
  QrCheckRequest,
  QrCheckResponse,
  Rec,
  UserResult,
  WriteOpts,
  WzUser,
} from "./types.js";

// The SDK registries are filled by the system's generated types; ui-kit calls the hooks by plain names.
type Loose = Record<string, unknown>;
type ListState = {
  items: Loose[];
  total: number;
  isLoading: boolean;
  error: WizardError | undefined;
  refetch(): void;
};
type QState = { data: unknown; error: WizardError | undefined; isLoading: boolean; refetch(): void };
const list = useEntityList as unknown as (
  e: string,
  o: { filter?: Loose; sort?: string; page?: number; limit?: number },
) => ListState;
const one = useEntity as unknown as (e: string, id: string | undefined) => QState;
const mut = useEntityMutation as unknown as (e: string) => {
  create(doc: Loose, o?: WriteOpts): Promise<Rec>;
  update(id: string, patch: Loose, o?: WriteOpts): Promise<Rec>;
  remove(id: string): Promise<void>;
};
const fnQuery = useQuery as unknown as (n: string, a: unknown) => QState;
const fnMutation = useMutation as unknown as (
  n: string,
) => [(a: unknown, o?: WriteOpts) => Promise<unknown>, { pending: boolean; error?: WizardError }];

const err = (e: WizardError | undefined) => (e ? toWzError(e) : undefined);

/** ListQuery → sdk EntityListOptions (sort "-field", limit ≤ 100, search → contains on the first string field). */
export function toSdkListOptions(
  q: ListQuery,
  searchField: string | undefined,
): { filter?: Loose; sort?: string; page?: number; limit?: number } {
  const filter: Loose = { ...(q.filter ?? {}) };
  if (q.search && searchField) filter[searchField] = { contains: q.search };
  return {
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(q.sort ? { sort: q.sort.dir === "desc" ? `-${q.sort.field}` : q.sort.field } : {}),
    ...(q.page ? { page: q.page } : {}),
    ...(q.pageSize ? { limit: Math.min(100, q.pageSize) } : {}),
  };
}

export function sdkDataSource(): DataSource {
  return {
    useList<T>(entity: string, q: ListQuery): AsyncResult<{ items: T[]; total: number }> {
      const spec = useRoleSpec();
      const s = list(entity, toSdkListOptions(q, titleField(spec, entity)));
      const data = useMemo(() => ({ items: s.items as T[], total: s.total }), [s.items, s.total]);
      const e = err(s.error);
      return {
        ...(s.isLoading && !s.items.length ? {} : { data }),
        isLoading: s.isLoading,
        ...(e ? { error: e } : {}),
        refetch: s.refetch,
      };
    },
    useRecord<T>(entity: string, id: string): AsyncResult<T> {
      const s = one(entity, id);
      const e =
        err(s.error) ??
        (!s.isLoading && s.data === null
          ? { code: "NOT_FOUND", message: "Запись не найдена", status: 404 }
          : undefined);
      return {
        ...(s.data ? { data: s.data as T } : {}),
        isLoading: s.isLoading,
        ...(e ? { error: e } : {}),
        refetch: s.refetch,
      };
    },
    useCreate(entity) {
      const m = mut(entity);
      return useMutationState((values: Loose, opts?: WriteOpts) => m.create(values, opts));
    },
    useUpdate(entity) {
      const m = mut(entity);
      return useMutationState((id: string, patch: Loose, opts?: WriteOpts) => m.update(id, patch, opts));
    },
    useRemove(entity) {
      const m = mut(entity);
      return useMutationState((id: string) => m.remove(id));
    },
    useFn<T>(name: string, args?: unknown): AsyncResult<T> {
      const s = fnQuery(name, args === undefined ? {} : args);
      const e = err(s.error);
      return {
        ...(s.data !== undefined ? { data: s.data as T } : {}),
        isLoading: s.isLoading,
        ...(e ? { error: e } : {}),
        refetch: s.refetch,
      };
    },
    useUser(): UserResult {
      const u = useUser();
      return {
        user: u.user as WzUser | null,
        isLoading: u.isLoading,
        login: (o) => u.login(o as never),
        logout: u.logout,
      };
    },
    useCall<R>(name: string) {
      const [run] = fnMutation(name);
      return useMutationState((args: unknown, opts?: WriteOpts) => run(args, opts) as Promise<R>);
    },
    useAuth(): AuthApi {
      const client = useSdkClient();
      return useMemo(
        () => ({
          start: (channel, destination) =>
            client.request<{ challengeId: string }>("POST", "/api/auth/otp/start", { channel, destination }),
          verify: async (challengeId, code) => {
            const r = await client.request<{ user: WzUser }>("POST", "/api/auth/otp/verify", {
              challengeId,
              code,
            });
            await client.refreshUser();
            return r.user;
          },
          redirect: (method, next) => {
            const q = next ? `?next=${encodeURIComponent(next)}` : "";
            if (typeof window !== "undefined") window.location.assign(`/api/auth/${method}/start${q}`);
          },
        }),
        [client],
      );
    },
    useQrCheck(verifyFn?: string) {
      const client = useSdkClient();
      return useMemo(
        () =>
          async (req: QrCheckRequest): Promise<QrCheckResponse> => {
            if (verifyFn) return (await client.callFunction(verifyFn, req)).result as QrCheckResponse;
            return client.request<QrCheckResponse>("POST", "/_wizard/qr/check", req);
          },
        [client, verifyFn],
      );
    },
  };
}
