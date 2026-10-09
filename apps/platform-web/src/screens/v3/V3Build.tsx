// «Собрать» of a v3 system on the canvas (V3-06 with V3-09 and V3-11): once the brief is ready (stage card, no plan)
// the chat shows the direction of the site (the three first screens of V3-09 open over the canvas, the pick goes into
// the brief and its short version) and «Собрать» with the cap of a v3 build — POST /systems/:id/brief/approve with the
// brief version the owner saw. While the build runs, the build row shows «потрачено X ₽ из Y» from the harness lines.
import type { SystemBrief } from "@wizard/appspec";
import { ActionButton, archetypeName } from "@wizard/ui-kit/v2";
import { type ReactNode, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { Run, RunEvent } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import type { DirectionsApi } from "../../v3/directions/api.js";
import { DirectionsCard } from "../../v3/directions/DirectionsCard.js";
import { BriefDrawer } from "../brief/CanvasBrief.js";
import { v3Ru } from "./ru.js";
import s from "./V3Build.module.css";

const T = v3Ru.build;

/** The cap of a v3 build in ₽ (D77 (11): builds-v3/host.ts V3_BUILD_CAP_CREDITS = 100 credits × 5 ₽). */
export const V3_BUILD_CAP_RUB = 500;

/** «потрачено 120 ₽ из 500 ₽» of the latest harness line of the build (agent_message), null before one. */
export function spentLine(events: readonly RunEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as RunEvent;
    if (e.type !== "agent_message") continue;
    const text = typeof e.payload.text === "string" ? e.payload.text : "";
    const m = /потрачено\s+[^.;()]+?\s+из\s+[^.;()]+?₽/.exec(text);
    if (m) return m[0];
  }
  return null;
}

export interface V3BuildCardProps {
  systemId: string;
  /** The latest brief version (the one «Собрать» approves). */
  version: number;
  brief: SystemBrief;
  /** The owner may start the build and pick the style. */
  editable: boolean;
  /** The build started: the canvas follows its run. */
  onStarted(run: Run): void;
  /** «Выбрать стиль»: the canvas opens the three directions over itself (StyleDrawer). */
  onStyle(): void;
  /** A stale brief (412): the canvas re-reads it. */
  onStale(): void;
}

/** The chat card before «Собрать» of a v3 system: the style of the site and the start of the build. */
export function V3BuildCard({
  systemId,
  version,
  brief,
  editable,
  onStarted,
  onStyle,
  onStale,
}: V3BuildCardProps): ReactNode {
  const { api } = usePlatform();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archetype = brief.design.archetype;
  const styleText = archetype
    ? brief.design.pinned
      ? T.stylePinned(archetypeName(archetype))
      : T.styleAuto(archetypeName(archetype))
    : T.styleNone;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.approveBrief(systemId, version);
      onStarted(r.run);
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        setError(T.stale);
        onStale();
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.card} aria-label={T.title} data-testid="canvas-v3-build">
      <div className={s.style}>
        <p className={s.line}>
          <span className={s.k}>{T.style}:</span>{" "}
          <span data-testid="canvas-v3-style" data-archetype={archetype ?? undefined}>
            {styleText}
          </span>
        </p>
        {editable && (
          <ActionButton size="sm" testId="canvas-v3-style-open" onClick={onStyle}>
            {archetype && brief.design.pinned ? T.change : T.pick}
          </ActionButton>
        )}
      </div>
      <div className={s.go}>
        <p className={s.note}>{T.note(V3_BUILD_CAP_RUB)}</p>
        {editable && (
          <ActionButton
            variant="create"
            testId="canvas-v3-approve"
            busy={busy}
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? T.starting : T.start(V3_BUILD_CAP_RUB)}
          </ActionButton>
        )}
      </div>
      {error && (
        <p className={s.error} role="alert" data-testid="canvas-v3-error">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * The three directions of V3-09 over the canvas (rendered by the canvas next to the brief panel, outside the floating
 * chat): the pick goes into the brief, the drawer closes and the canvas re-reads the brief.
 */
export function StyleDrawer({
  systemId,
  editable,
  onClose,
  onPicked,
  api,
}: {
  systemId: string;
  editable: boolean;
  onClose(): void;
  onPicked(): void;
  /** Default: the platform API of the directions (tests pass a double). */
  api?: DirectionsApi;
}): ReactNode {
  return (
    <BriefDrawer label={T.drawer} testId="canvas-v3-style-drawer" onClose={onClose}>
      <div className={s.drawer}>
        <header className={s.drawerHead}>
          <h2 className={s.drawerTitle}>{T.drawer}</h2>
          <button
            type="button"
            className={s.close}
            aria-label={T.close}
            data-drawer-close=""
            data-testid="canvas-v3-style-close"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className={s.drawerBody}>
          <DirectionsCard
            systemId={systemId}
            editable={editable}
            onPicked={onPicked}
            {...(api ? { api } : {})}
          />
        </div>
      </div>
    </BriefDrawer>
  );
}
