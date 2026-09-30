// React hooks of @wizard/sdk (sdk.md §3). All network access goes through SdkClient.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { WizardError } from "../errors.js";
import type {
  ActionName,
  CallOptions,
  ClientDoc,
  EntityListOptions,
  EntityListState,
  EntityMutations,
  EntityName,
  FnArgs,
  FnResult,
  Id,
  MutationName,
  PaymentState,
  Payments,
  QueryName,
  QueryState,
  RoleName,
  UserState,
} from "../types.js";
import { type ListResponse, type RealtimeMessage, SdkClient, type SdkClientOptions } from "./transport.js";

// ---------- provider ----------

export interface SdkProviderProps extends SdkClientOptions {
  /** Ready client (tests, ui-kit); otherwise one is created from the other props. */
  client?: SdkClient;
  /** Route patterns of the system (pages[].route) for useParams. */
  routes?: readonly string[];
  /** Router integration; default: History API. */
  navigate?: (to: string) => void;
  /** Current path; default: window.location.pathname (updated on popstate). */
  pathname?: string;
  /** Leaves the SPA (payment page); default: window.location.assign. */
  redirect?: (url: string) => void;
  /** Invalidation debounce (sdk.md §3: 100 ms). */
  debounceMs?: number;
  children?: ReactNode;
}

interface SdkContextValue {
  client: SdkClient;
  routes: readonly string[];
  navigate: (to: string) => void;
  pathname: string | undefined;
  redirect: (url: string) => void;
  debounceMs: number;
}

const SdkContext = createContext<SdkContextValue | null>(null);

function historyNavigate(to: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function assignLocation(url: string): void {
  if (typeof window !== "undefined") window.location.assign(url);
}

let defaultCtx: SdkContextValue | undefined;
function getDefaultCtx(): SdkContextValue {
  defaultCtx ??= {
    client: new SdkClient(),
    routes: [],
    navigate: historyNavigate,
    pathname: undefined,
    redirect: assignLocation,
    debounceMs: 100,
  };
  return defaultCtx;
}

export function SdkProvider(props: SdkProviderProps): ReactNode {
  const { client: given, baseUrl, fetch, realtime, consent, reconnectDelayMs } = props;
  // Client options are read once per provider (one SSE connection per tab); pass `client` to swap it.
  const [own] = useState(() =>
    given ? undefined : new SdkClient({ baseUrl, fetch, realtime, consent, reconnectDelayMs }),
  );
  const client = given ?? (own as SdkClient);
  useEffect(() => () => own?.close(), [own]);
  const value = useMemo<SdkContextValue>(
    () => ({
      client,
      routes: props.routes ?? [],
      navigate: props.navigate ?? historyNavigate,
      pathname: props.pathname,
      redirect: props.redirect ?? assignLocation,
      debounceMs: props.debounceMs ?? 100,
    }),
    [client, props.routes, props.navigate, props.pathname, props.redirect, props.debounceMs],
  );
  return <SdkContext.Provider value={value}>{props.children}</SdkContext.Provider>;
}

function useSdkContext(): SdkContextValue {
  return useContext(SdkContext) ?? getDefaultCtx();
}

/** The SdkClient of the nearest SdkProvider (ui-kit uses it for /api/auth/* login flows). */
export function useSdkClient(): SdkClient {
  return useSdkContext().client;
}

// ---------- shared remote-state hook ----------

interface RemoteState<T> {
  key: string | null;
  data: T | undefined;
  error: WizardError | undefined;
  isLoading: boolean;
}

function asWizardError(e: unknown): WizardError {
  return e instanceof WizardError ? e : new WizardError("INTERNAL", { message: "Внутренняя ошибка" });
}

/**
 * Loads `fetcher()` for `key` (null = skip), refetches on `refetch()`, on matching invalidation
 * (debounced) and on resync. Keeps previous data of the same key while refetching.
 */
function useRemote<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  affects: (m: Extract<RealtimeMessage, { type: "invalidate" }>) => boolean,
): RemoteState<T> & { refetch(): void } {
  const { client, debounceMs } = useSdkContext();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<RemoteState<T>>({
    key,
    data: undefined,
    error: undefined,
    isLoading: key !== null,
  });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const affectsRef = useRef(affects);
  affectsRef.current = affects;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refetch trigger
  useEffect(() => {
    if (key === null) {
      setState({ key, data: undefined, error: undefined, isLoading: false });
      return;
    }
    let cancelled = false;
    setState((s) =>
      s.key === key ? { ...s, isLoading: true } : { key, data: undefined, error: undefined, isLoading: true },
    );
    fetcherRef.current().then(
      (data) => {
        if (!cancelled) setState({ key, data, error: undefined, isLoading: false });
      },
      (e: unknown) => {
        if (!cancelled)
          setState((s) => ({
            key,
            data: s.key === key ? s.data : undefined,
            error: asWizardError(e),
            isLoading: false,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  useEffect(() => {
    if (key === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.subscribe((m) => {
      if (m.type === "invalidate" && !affectsRef.current(m)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setNonce((n) => n + 1), debounceMs);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, key, debounceMs]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const current: RemoteState<T> =
    state.key === key ? state : { key, data: undefined, error: undefined, isLoading: key !== null };
  return { ...current, refetch };
}

/** Deterministic JSON for cache keys (object keys sorted). */
export function stableKey(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );
}

// ---------- functions ----------

export function useQuery<N extends QueryName>(name: N, args: FnArgs<N> | "skip"): QueryState<FnResult<N>> {
  const { client } = useSdkContext();
  const key = args === "skip" ? null : `fn:${name}:${stableKey(args)}`;
  const argsRef = useRef(args);
  argsRef.current = args;
  const depsRef = useRef<ReadonlySet<string>>(new Set());
  const s = useRemote<FnResult<N>>(
    key,
    async () => {
      const r = await client.callFunction(name, argsRef.current);
      depsRef.current = new Set(r.deps);
      return r.result as FnResult<N>;
    },
    (m) => depsRef.current.has(m.entity),
  );
  return { data: s.data, error: s.error, isLoading: s.isLoading, refetch: s.refetch };
}

export function useMutation<N extends MutationName | ActionName>(
  name: N,
): [
  (args: FnArgs<N>, opts?: CallOptions) => Promise<FnResult<N>>,
  { pending: boolean; error: WizardError | undefined },
] {
  const { client } = useSdkContext();
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<WizardError | undefined>(undefined);
  const run = useCallback(
    async (args: FnArgs<N>, opts?: CallOptions): Promise<FnResult<N>> => {
      setPending((n) => n + 1);
      setError(undefined);
      try {
        const r = await client.callFunction(name, args, opts);
        return r.result as FnResult<N>;
      } catch (e) {
        const err = asWizardError(e);
        setError(err);
        throw err;
      } finally {
        setPending((n) => n - 1);
      }
    },
    [client, name],
  );
  return [run, { pending: pending > 0, error }];
}

// ---------- entities (data API) ----------

export function useEntityList<E extends EntityName>(
  entity: E,
  opts: EntityListOptions<E> = {},
): EntityListState<E> {
  const { client } = useSdkContext();
  const key = `list:${entity}:${stableKey(opts)}`;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const s = useRemote<ListResponse<ClientDoc<E>>>(
    key,
    () => {
      const o = optsRef.current;
      return client.listEntities<ClientDoc<E>>(entity, {
        filter: o.filter as Record<string, unknown> | undefined,
        sort: o.sort as string | string[] | undefined,
        page: o.page,
        limit: o.limit,
      });
    },
    (m) => m.entity === entity,
  );
  return {
    items: s.data?.items ?? [],
    total: s.data?.total ?? 0,
    page: s.data?.page ?? opts.page ?? 1,
    limit: s.data?.limit ?? opts.limit ?? 20,
    hasMore: s.data?.hasMore ?? false,
    isLoading: s.isLoading,
    error: s.error,
    refetch: s.refetch,
  };
}

export function useEntity<E extends EntityName>(
  entity: E,
  id: Id<E> | string | undefined,
): QueryState<ClientDoc<E> | null> {
  const { client } = useSdkContext();
  const key = id ? `get:${entity}:${id}` : null;
  const s = useRemote<ClientDoc<E> | null>(
    key,
    () => client.getEntity<ClientDoc<E>>(entity, String(id)),
    (m) => m.entity === entity && (m.id === undefined || m.id === id),
  );
  return { data: s.data, error: s.error, isLoading: s.isLoading, refetch: s.refetch };
}

export function useEntityMutation<E extends EntityName>(entity: E): EntityMutations<E> {
  const { client } = useSdkContext();
  return useMemo(
    () => ({
      create: (doc, opts) => client.createEntity<ClientDoc<E>>(entity, doc, opts),
      update: (id, patch, opts) => client.updateEntity<ClientDoc<E>>(entity, String(id), patch, opts),
      remove: (id) => client.removeEntity(entity, String(id)),
    }),
    [client, entity],
  );
}

// ---------- auth ----------

export function useUser(): UserState {
  const { client, navigate } = useSdkContext();
  const snap = useSyncExternalStore(client.subscribeUser, client.getUserSnapshot, client.getUserSnapshot);
  useEffect(() => {
    void client.loadUser().catch(() => {});
  }, [client]);
  const login = useCallback(
    (o: { role?: RoleName; next?: string } = {}) => {
      const q = new URLSearchParams();
      if (o.role) q.set("role", o.role);
      if (o.next) q.set("next", o.next);
      const s = q.toString();
      navigate(`/login${s ? `?${s}` : ""}`);
    },
    [navigate],
  );
  const logout = useCallback(() => client.logout(), [client]);
  return { user: snap.user, isLoading: snap.isLoading, login, logout };
}

// ---------- payments ----------

export function usePayment<I extends keyof Payments & string>(integration: I): PaymentState<I> {
  const { client, redirect } = useSdkContext();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<WizardError | undefined>(undefined);
  const pay = useCallback(
    async (binding: Payments[I], id: string) => {
      setPending(true);
      setError(undefined);
      try {
        redirect(await client.pay(integration, String(binding), id));
      } catch (e) {
        const err = asWizardError(e);
        setError(err);
        throw err;
      } finally {
        setPending(false);
      }
    },
    [client, integration, redirect],
  );
  return { pay, pending, error };
}

// ---------- routing ----------

/** Matches `/ticket/:id` against a path; returns params or null. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const split = (s: string) => s.split("/").filter(Boolean);
  const p = split(pattern);
  const a = split(path.split(/[?#]/)[0] ?? "");
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    const val = a[i] as string;
    if (seg.startsWith(":")) out[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return out;
}

function subscribeLocation(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

function getPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const { routes, pathname } = useSdkContext();
  const live = useSyncExternalStore(subscribeLocation, getPathname, () => "/");
  const path = pathname ?? live;
  return useMemo(() => {
    // Static segments win over params: /ticket/new before /ticket/:id.
    const ordered = [...routes].sort((a, b) => a.split(":").length - b.split(":").length);
    for (const r of ordered) {
      const m = matchRoute(r, path);
      if (m) return m as T;
    }
    return {} as T;
  }, [routes, path]);
}

export function useNavigate(): (to: string) => void {
  return useSdkContext().navigate;
}
