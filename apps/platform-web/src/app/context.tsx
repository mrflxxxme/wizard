// Platform providers: API client, org settings (build model label, L4-20) and the ui-kit theme of the platform.
import { type RoleSpec, themeToTokens, WzProvider } from "@wizard/ui-kit";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type ApiClient, createApiClient, M0_ORG_ID } from "../api/client.js";
import type { OrgSettings } from "../api/types.js";

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

interface PlatformValue {
  api: ApiClient;
  settings: OrgSettings | null;
}

const Ctx = createContext<PlatformValue | null>(null);

export function PlatformProvider({ api, children }: { api?: ApiClient; children: ReactNode }): ReactNode {
  const client = useMemo(() => api ?? createApiClient(), [api]);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  useEffect(() => {
    let live = true;
    // M1 endpoint; in M0 the platform-api may not serve it — then no model label is shown (not a constant, L4-20).
    client
      .getOrgSettings(M0_ORG_ID)
      .then((s) => live && setSettings(s))
      .catch(() => live && setSettings(null));
    return () => {
      live = false;
    };
  }, [client]);
  useEffect(() => applyPlatformTokens(document.documentElement), []);
  const value = useMemo(() => ({ api: client, settings }), [client, settings]);
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
