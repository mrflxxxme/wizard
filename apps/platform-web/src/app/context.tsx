// Platform providers: API client, the signed-in user and the current organization (GET /me, api.yaml x-auth M1),
// org settings (build model label, ruOnly, L4-20) and the ui-kit theme of the platform.
import { type RoleSpec, themeToTokens, WzProvider } from "@wizard/ui-kit";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ApiClient, ApiError, createApiClient, M0_ORG_ID } from "../api/client.js";
import type { Me, OrgRole, OrgSettings } from "../api/types.js";

/** Platform UI is a RoleSpec-less app: an empty spec only carries the platform theme for ui-kit components. */
const PLATFORM_SPEC: RoleSpec = {
  app: { name: "Wizard" },
  role: null,
  roles: [],
  entities: [],
  permissions: [],
  pages: [],
  theme: { accent: "#2F46D8", font: "Onest", radius: 8, density: "regular", mode: "light" },
  loginMethods: [],
};

/** CSSOM only: CSP forbids inline <style> (ui-kit applyTokens), setProperty is allowed. */
function applyPlatformTokens(root: HTMLElement): void {
  for (const [k, v] of Object.entries(themeToTokens(PLATFORM_SPEC.theme, "light")))
    root.style.setProperty(k, v);
  root.setAttribute("data-wz-mode", "light");
}

const ORG_KEY = "wz.orgId";
const readOrg = (): string | null => {
  try {
    return window.localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
};
const writeOrg = (id: string): void => {
  try {
    window.localStorage.setItem(ORG_KEY, id);
  } catch {
    // Private mode: the choice lives for this tab only.
  }
};

/**
 * "loading" — GET /me in flight; "anon" — no session (401): the app shows /login; "ready" — signed in;
 * "unavailable" — the API has no /me (M0) or failed: the M0 organization is used, owner-only controls stay off.
 */
export type AuthState = "loading" | "anon" | "ready" | "unavailable";

export interface PlatformValue {
  api: ApiClient;
  auth: AuthState;
  me: Me | null;
  /** Current organization (S1 lists and creates systems there; S10 of a system uses the system's org). */
  orgId: string;
  /** Role in an organization, null when unknown. */
  roleIn(orgId: string | undefined): OrgRole | null;
  setOrg(orgId: string): void;
  reloadMe(): Promise<Me | null>;
  /** Settings of the current organization (null — unknown: no model label is shown, never a constant). */
  settings: OrgSettings | null;
  setSettings(s: OrgSettings): void;
}

const Ctx = createContext<PlatformValue | null>(null);

function pickOrg(me: Me | null, preferred: string | null): string {
  const ms = me?.memberships ?? [];
  if (preferred && ms.some((m) => m.orgId === preferred)) return preferred;
  return ms.find((m) => m.orgId === M0_ORG_ID)?.orgId ?? ms[0]?.orgId ?? M0_ORG_ID;
}

export function PlatformProvider({ api, children }: { api?: ApiClient; children: ReactNode }): ReactNode {
  const [auth, setAuth] = useState<AuthState>("loading");
  const onUnauthorized = useRef(() => {});
  const client = useMemo(
    () => api ?? createApiClient({ onUnauthorized: () => onUnauthorized.current() }),
    [api],
  );
  const [me, setMe] = useState<Me | null>(null);
  const [orgId, setOrgId] = useState<string>(() => readOrg() ?? M0_ORG_ID);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  onUnauthorized.current = () => {
    setMe(null);
    setAuth("anon");
  };

  const reloadMe = useCallback(async (): Promise<Me | null> => {
    try {
      const m = await client.getMe();
      setMe(m);
      setOrgId((cur) => pickOrg(m, cur));
      setAuth("ready");
      return m;
    } catch (e) {
      setMe(null);
      // Without GET /me (M0 API, test doubles) the platform keeps working on the local organization.
      setAuth(e instanceof ApiError && e.status === 401 ? "anon" : "unavailable");
      return null;
    }
  }, [client]);

  useEffect(() => {
    void reloadMe();
  }, [reloadMe]);

  useEffect(() => {
    if (auth === "loading" || auth === "anon") return;
    let live = true;
    // api.yaml M1 endpoint, served read-only from M0 (M0-30); on error no model label is shown (not a constant, L4-20).
    client
      .getOrgSettings(orgId)
      .then((s) => live && setSettings(s))
      .catch(() => live && setSettings(null));
    return () => {
      live = false;
    };
  }, [client, orgId, auth]);

  useEffect(() => applyPlatformTokens(document.documentElement), []);

  const setOrg = useCallback((id: string) => {
    writeOrg(id);
    setOrgId(id);
  }, []);
  const roleIn = useCallback(
    (id: string | undefined) => me?.memberships.find((m) => m.orgId === id)?.role ?? null,
    [me],
  );

  const value = useMemo<PlatformValue>(
    () => ({ api: client, auth, me, orgId, roleIn, setOrg, reloadMe, settings, setSettings }),
    [client, auth, me, orgId, roleIn, setOrg, reloadMe, settings],
  );
  return (
    <WzProvider spec={PLATFORM_SPEC} applyTheme={false}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </WzProvider>
  );
}

export function usePlatform(): PlatformValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlatform outside PlatformProvider");
  return v;
}

/** Owner-only actions (D11): enabled for the owner; unknown role (no /me) keeps them off — the server decides. */
export const canOwn = (role: OrgRole | null): boolean => role === "owner";
/** Editing (messages, «Строить», «Стиль», «Отменить»): owner and editor; unknown role (M0 API) — allowed. */
export const canEdit = (role: OrgRole | null, auth: AuthState): boolean =>
  role === "owner" || role === "editor" || (role === null && auth === "unavailable");
