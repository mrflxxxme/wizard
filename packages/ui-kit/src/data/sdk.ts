// sdkDataSource(): DataSource over @wizard/sdk client hooks (ui-kit.yaml#data_binding.sdk_mapping).
import {
  SdkClient,
  useEntity,
  useEntityList,
  useEntityMutation,
  useQuery,
  useSdkClient,
  useUser,
  type WizardError,
} from "@wizard/sdk";
import { useMemo } from "react";
import { ru } from "../i18n/ru.js";
import { useRoleSpec } from "./context.js";
import { toWzError, useMutationState } from "./mutation.js";
import { titleField } from "./roleSpec.js";
import type {
  AiActionResult,
  AsyncResult,
  AuthApi,
  DataSource,
  FileInfo,
  FilesApi,
  ListQuery,
  QrCheckRequest,
  QrCheckResponse,
  QrManifest,
  QrOfflineApi,
  QrSyncResponse,
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
          ? { code: "NOT_FOUND", message: ru.server.NOT_FOUND, status: 404 }
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
    useCall<R>() {
      const client = useSdkClient();
      return useMutationState(
        async (name: string, args: unknown, opts?: WriteOpts) =>
          (await client.callFunction(name, args, opts)).result as R,
      );
    },
    useAuth(): AuthApi {
      const client = useSdkClient();
      return useMemo(
        () => ({
          start: (channel, destination, opts) =>
            client.request<{ challengeId: string }>("POST", "/api/auth/otp/start", {
              channel,
              destination,
              ...(opts?.role ? { role: opts.role } : {}),
            }),
          verify: async (challengeId, code, consent) => {
            const r = await client.request<{ user: WzUser }>("POST", "/api/auth/otp/verify", {
              challengeId,
              code,
              ...(consent ? { _consent: consent } : {}),
            });
            await client.refreshUser();
            return r.user;
          },
          redirect: (method, next, opts) => {
            const q = new URLSearchParams();
            if (next) q.set("next", next);
            if (opts?.role) q.set("role", opts.role);
            if (opts?.consent) {
              q.set("pv", opts.consent.policyVersion);
              q.set("th", opts.consent.textHash);
            }
            const qs = q.toString();
            if (typeof window !== "undefined")
              window.location.assign(`/api/auth/${method}/start${qs ? `?${qs}` : ""}`);
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
    useAiAction() {
      const client = useSdkClient();
      return useMutationState(
        async (action: string, entity: string, id: string): Promise<AiActionResult> =>
          client.runAiAction(action, entity, id),
      );
    },
    useFiles() {
      const client = useSdkClient();
      return useMemo<FilesApi>(() => {
        const href = (fileId: string) => `${client.baseUrl}/api/files/${encodeURIComponent(fileId)}`;
        return {
          href,
          info: (fileId) => client.request<FileInfo>("GET", `/api/files/${encodeURIComponent(fileId)}/info`),
          async upload(file, target) {
            const form = new FormData();
            form.set("file", file, file.name);
            form.set("field", target.field);
            if (target.entity) form.set("entity", target.entity);
            let res: Response;
            try {
              res = await fetch(`${client.baseUrl}/api/files`, {
                method: "POST",
                // runtime.yaml#auth.csrf; the browser sets the multipart Content-Type with its boundary.
                headers: { Accept: "application/json", "X-Wizard-Request": "1" },
                body: form,
                credentials: "same-origin",
              });
            } catch {
              throw toWzError(SdkClient.toError(0, { error: { code: "NETWORK" } }));
            }
            const json: unknown = await res.json().catch(() => undefined);
            if (!res.ok) throw toWzError(SdkClient.toError(res.status, json));
            return json as FileInfo;
          },
        };
      }, [client]);
    },
    useQrOffline() {
      const client = useSdkClient();
      return useMemo<QrOfflineApi>(
        () => ({
          manifest: (since) =>
            client.request<QrManifest>(
              "GET",
              `/_wizard/qr/manifest${since ? `?since=${encodeURIComponent(since)}` : ""}`,
            ),
          sync: (req) => client.request<QrSyncResponse>("POST", "/_wizard/qr/sync", req),
        }),
        [client],
      );
    },
  };
}
