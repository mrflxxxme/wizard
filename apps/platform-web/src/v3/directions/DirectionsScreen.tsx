// /s/:systemId?view=design (V3-09): the «Три направления» card on its own platform page until the v3 chat (V3-06)
// embeds it in the sessions feed. The system route is still the legacy v1 document, so the screen carries its own v2
// root (like the canvas). A viewer only looks; an editor picks, refines and adds references.
import "@wizard/ui-kit/v2/theme.css";
import { ThemeRoot } from "@wizard/ui-kit/v2";
import type { ReactNode } from "react";
import { canEdit, usePlatform } from "../../app/context.js";
import { PlatformPage } from "../../components/v2/Shell.js";
import s from "./Directions.module.css";
import { DirectionsCard } from "./DirectionsCard.js";
import { directionsRu } from "./texts.js";

export function DirectionsScreen({ systemId }: { systemId: string }): ReactNode {
  const { orgId, roleIn, auth, theme } = usePlatform();
  const role = roleIn(orgId);
  return (
    <ThemeRoot theme={theme} grain={false} className={s.screen} testId="directions-root">
      <PlatformPage title={directionsRu.screenTitle} testId="directions-screen">
        <main>
          <DirectionsCard systemId={systemId} editable={role === null || canEdit(role, auth)} />
        </main>
      </PlatformPage>
    </ThemeRoot>
  );
}
