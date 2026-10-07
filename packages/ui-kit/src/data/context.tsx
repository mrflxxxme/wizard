// WzProvider (ui-kit.yaml#data_binding.provider): RoleSpec, DataSource and theme for the whole app.
import type { PermissionOp } from "@wizard/appspec";
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
import "../base.css";
import "../tokens/cabinet.css";
import { applyTokens } from "../tokens/tokens.js";
import { can, type RoleSpec } from "./roleSpec.js";
import { sdkDataSource } from "./sdk.js";
import type { DataSource, WzUser } from "./types.js";

export interface WzProviderProps {
  spec: RoleSpec;
  dataSource?: DataSource;
  /** Overrides the user reported by the DataSource (tests, preview). */
  user?: WzUser | null;
  /** Apply theme tokens to document.documentElement (default true). */
  applyTheme?: boolean;
  /** Router integration; default: History API + popstate. */
  navigate?: (to: string) => void;
  /** Current path (may include ?search); default: window.location. */
  pathname?: string;
  children?: ReactNode;
}

interface WzContextValue {
  spec: RoleSpec;
  ds: DataSource;
  user: WzUser | null | undefined;
  navigate: (to: string) => void;
  pathname: string | undefined;
  nextOrdinal(name: string): number;
}

const WzContext = createContext<WzContextValue | null>(null);

function historyNavigate(to: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function WzProvider({
  spec,
  dataSource,
  user,
  applyTheme = true,
  navigate = historyNavigate,
  pathname,
  children,
}: WzProviderProps): ReactNode {
  const [fallback] = useState(sdkDataSource);
  const ds = dataSource ?? fallback;
  const counters = useRef(new Map<string, number>());
  const value = useMemo<WzContextValue>(
    () => ({
      spec,
      ds,
      user,
      navigate,
      pathname,
      nextOrdinal: (name) => {
        const n = (counters.current.get(name) ?? 0) + 1;
        counters.current.set(name, n);
        return n;
      },
    }),
    [spec, ds, user, navigate, pathname],
  );
  useEffect(() => {
    if (applyTheme && typeof document !== "undefined") applyTokens(document.documentElement, spec.theme);
  }, [applyTheme, spec.theme]);
  return <WzContext.Provider value={value}>{children}</WzContext.Provider>;
}

export function useWz(): WzContextValue {
  const v = useContext(WzContext);
  if (!v) throw new Error("@wizard/ui-kit: component must be rendered inside WzProvider");
  return v;
}

export function useRoleSpec(): RoleSpec {
  return useWz().spec;
}

export function useDataSource(): DataSource {
  return useWz().ds;
}

/** can(op, entity, field?) bound to the current RoleSpec. */
export function useCan(): (op: PermissionOp, entity: string, field?: string) => boolean {
  const spec = useRoleSpec();
  return useMemo(
    () => (op: PermissionOp, entity: string, field?: string) => can(spec, op, entity, field),
    [spec],
  );
}

/** Current user: WzProvider.user wins over the DataSource. */
export function useWzUser() {
  const { ds, user } = useWz();
  const r = ds.useUser();
  return user === undefined ? r : { ...r, user, isLoading: false };
}

function subscribeLocation(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", cb);
  window.addEventListener("hashchange", cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener("hashchange", cb);
  };
}
const locationKey = () =>
  typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;

/** Current pathname and search (WzProvider.pathname wins), reactive to popstate. */
export function useLocation(): { pathname: string; search: string } {
  const { pathname } = useWz();
  const live = useSyncExternalStore(subscribeLocation, locationKey, () => "/");
  const [p, q] = (pathname ?? live).split("?");
  return { pathname: p || "/", search: q ? `?${q}` : "" };
}

export function useNavigate(): (to: string) => void {
  const { navigate } = useWz();
  return useCallback((to: string) => navigate(to), [navigate]);
}

export type WzBase = { wzId?: string; testId?: string; className?: string };

/** data-wz-component, data-wz-id (fallback demo:<Name>:<n>) and data-testid for a component root. */
export function useWzRoot(name: string, testBase: string, props: WzBase) {
  const { nextOrdinal } = useWz();
  const [ordinal] = useState(() => (props.wzId ? 0 : nextOrdinal(name)));
  return {
    "data-wz-component": name,
    "data-wz-id": props.wzId ?? `demo:${name}:${ordinal}`,
    "data-testid": testId(testBase, props.testId),
  } as const;
}

export function testId(base: string, suffix?: string): string {
  return suffix ? `${base}--${suffix}` : base;
}

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}
