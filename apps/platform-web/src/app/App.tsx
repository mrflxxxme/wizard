// Routes: "/" → S1, "/s/:systemId" → workspace (S2–S7), "/s/:systemId/code" → S-code, "/s/:systemId/settings" →
// S10, "/s/:systemId/import/:importId" → S-import, "/billing" → S-billing, "/login" → S-auth, "/invite/:token" → S-invite,
// "/abuse" → «Пожаловаться» (public), "/admin" → staff console (M2-08), "/welcome" → S-welcome (pilot onboarding,
// M2-09). Without a session (401) every private route goes to /login. The «Написать команде» button (D68) is on every
// cabinet screen. B2-33: every screen except the canvas (own root) and the legacy workspace is on the design system v2 —
// <html> carries data-p-root with the light/dark choice.
import { applyPlatformTheme, Serif } from "@wizard/ui-kit/v2";
import { type ReactNode, useEffect, useLayoutEffect } from "react";
import { Spinner } from "../components/ui.js";
import { Button } from "../components/v2/Button.js";
import page from "../components/v2/page.module.css";
import { PlatformPage } from "../components/v2/Shell.js";
import { SupportWidget } from "../features/support/SupportWidget.js";
import { shell } from "../i18n/ru/shell.js";
import { ru } from "../i18n/ru.js";
import { AbuseForm } from "../screens/abuse/AbuseForm.js";
import { AdminConsole } from "../screens/admin/AdminConsole.js";
import { InviteScreen } from "../screens/auth/Invite.js";
import { Legal } from "../screens/auth/Legal.js";
import { Login } from "../screens/auth/Login.js";
import { BillingScreen } from "../screens/billing/Billing.js";
import { CodeScreen } from "../screens/code/CodeScreen.js";
import { ImportScreen } from "../screens/import/ImportScreen.js";
import { Welcome } from "../screens/onboarding/Welcome.js";
import { Start } from "../screens/Start.js";
import { Settings } from "../screens/settings/Settings.js";
import { Workspace } from "../screens/workspace/Workspace.js";
import { usePlatform } from "./context.js";
import { navigate, PUBLIC_ROUTES, type Route, useRoute } from "./router.js";

/** Routes still on ui-kit v1 (--w-*): the legacy workspace and its «Код» and import screens; the canvas has its root. */
const LEGACY: ReadonlySet<Route["name"]> = new Set(["system", "code", "import"]);

/** <html> as the v2 root (tokens, theme, paper grain) on the v2 routes; plain v1 document on the legacy ones. */
function useDocumentTheme(name: Route["name"]): void {
  const { theme, syncTheme } = usePlatform();
  // The canvas screen keeps its own copy of the choice: re-read it whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read on every route change
  useEffect(() => syncTheme(), [name, syncTheme]);
  useLayoutEffect(() => {
    const el = document.documentElement;
    if (LEGACY.has(name)) {
      for (const a of ["data-p-root", "data-p-theme", "data-p-grain", "data-p-glass"]) el.removeAttribute(a);
      return;
    }
    applyPlatformTheme(el, { theme });
  }, [name, theme]);
}

export function App(): ReactNode {
  const { route } = useRoute();
  useDocumentTheme(route.name);
  return (
    <>
      <Page />
      {/* D68: «Написать команде» on every cabinet screen (hidden on /admin, sign-in and public pages). */}
      <SupportWidget />
    </>
  );
}

function Page(): ReactNode {
  const { route } = useRoute();
  const { auth } = usePlatform();
  const needsLogin = auth === "anon" && !PUBLIC_ROUTES.has(route.name);
  useEffect(() => {
    if (!needsLogin) return;
    const here = window.location.pathname + window.location.search;
    navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
  }, [needsLogin]);

  if (route.name === "login") return <Login />;
  if (route.name === "invite") return <InviteScreen token={route.token} />;
  if (route.name === "legal") return <Legal doc={route.doc} />;
  if (route.name === "abuse") return <AbuseForm />;
  if (auth === "loading" || needsLogin)
    return (
      <main aria-busy="true" className={page.loading} data-testid="platform-loading">
        <Spinner label={shell.loading} />
        <span>{shell.loading}</span>
      </main>
    );
  if (route.name === "start") return <Start />;
  if (route.name === "billing") return <BillingScreen />;
  if (route.name === "welcome") return <Welcome />;
  if (route.name === "admin") return <AdminConsole />;
  if (route.name === "system") return <Workspace key={route.systemId} systemId={route.systemId} />;
  if (route.name === "code") return <CodeScreen key={route.systemId} systemId={route.systemId} />;
  if (route.name === "settings") return <Settings key={route.systemId} systemId={route.systemId} />;
  if (route.name === "import")
    return (
      <ImportScreen
        key={`${route.systemId}/${route.importId}`}
        systemId={route.systemId}
        importId={route.importId}
      />
    );
  return (
    <PlatformPage nav={false} testId="not-found">
      <main className={page.center}>
        <Serif as="h1" size="lg">
          {ru.errors.notFound}
        </Serif>
        <Button variant="primary" onClick={() => navigate("/")}>
          {ru.errors.toStart}
        </Button>
      </main>
    </PlatformPage>
  );
}
