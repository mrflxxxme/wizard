// Routes: "/" → S1, "/s/:systemId" → workspace (S2–S7), "/s/:systemId/code" → S-code, "/s/:systemId/settings" →
// S10, "/login" → S-auth, "/invite/:token" → S-invite. Without a session (401) every private route goes to /login.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useEffect } from "react";
import { ru } from "../i18n/ru.js";
import { InviteScreen } from "../screens/auth/Invite.js";
import { Legal } from "../screens/auth/Legal.js";
import { Login } from "../screens/auth/Login.js";
import { CodeScreen } from "../screens/code/CodeScreen.js";
import { Start } from "../screens/Start.js";
import { Settings } from "../screens/settings/Settings.js";
import { Workspace } from "../screens/workspace/Workspace.js";
import { usePlatform } from "./context.js";
import { navigate, PUBLIC_ROUTES, useRoute } from "./router.js";

export function App(): ReactNode {
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
  if (auth === "loading" || needsLogin)
    return (
      <main aria-busy="true" style={{ padding: 24 }}>
        {ru.code.loading}
      </main>
    );
  if (route.name === "start") return <Start />;
  if (route.name === "system") return <Workspace key={route.systemId} systemId={route.systemId} />;
  if (route.name === "code") return <CodeScreen key={route.systemId} systemId={route.systemId} />;
  if (route.name === "settings") return <Settings key={route.systemId} systemId={route.systemId} />;
  return (
    <main style={{ padding: 24 }}>
      <h1>{ru.errors.notFound}</h1>
      <Button variant="secondary" onClick={() => navigate("/")}>
        {ru.errors.toStart}
      </Button>
    </main>
  );
}
