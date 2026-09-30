// Routes: "/" → S1, "/s/:systemId" → workspace (S2–S7), "/s/:systemId/code" → S-code.
import { Button } from "@wizard/ui-kit";
import type { ReactNode } from "react";
import { ru } from "../i18n/ru.js";
import { CodeScreen } from "../screens/code/CodeScreen.js";
import { Start } from "../screens/Start.js";
import { Workspace } from "../screens/workspace/Workspace.js";
import { navigate, useRoute } from "./router.js";

export function App(): ReactNode {
  const { route } = useRoute();
  if (route.name === "start") return <Start />;
  if (route.name === "system") return <Workspace key={route.systemId} systemId={route.systemId} />;
  if (route.name === "code") return <CodeScreen key={route.systemId} systemId={route.systemId} />;
  return (
    <main style={{ padding: 24 }}>
      <h1>{ru.errors.notFound}</h1>
      <Button variant="secondary" onClick={() => navigate("/")}>
        {ru.errors.toStart}
      </Button>
    </main>
  );
}
