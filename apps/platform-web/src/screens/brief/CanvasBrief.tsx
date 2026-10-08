// The system brief on the canvas (V3-06, D77 (9), platform-screens.yaml#S-canvas): a system with a brief v3 gets the
// «Бриф» button, the short brief in the chat before «Собрать» and the panel with versions, difference, diagrams and the
// session feed. The owner edits in the panel (PUT /brief with the version he saw → a new version) or in words in the
// chat: the message goes the usual way and, when the server answers, the canvas calls reload() — the panel and the short
// brief re-read the brief. A system without a brief (v2) shows none of it.
import type { BriefDiagrams, SystemBrief } from "@wizard/appspec";
import {
  type BriefDiagramKey,
  BriefPanel,
  type BriefPanelTab,
  BriefSummary,
  type BriefVersionInfo,
} from "@wizard/ui-kit/v2";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { BriefVersion, SystemSession } from "../../api/types.js";
import { canEdit, usePlatform } from "../../app/context.js";
import { ru } from "../../i18n/ru.js";
import s from "./BriefDrawer.module.css";
import { briefRu } from "./ru.js";

interface Loaded {
  brief: BriefVersion;
  diagrams: BriefDiagrams;
}

export interface CanvasBrief {
  /** The system has a brief (GET /brief returned a version): the canvas shows the button and the short brief. */
  available: boolean;
  /** The panel is open. */
  open: boolean;
  /** Opens the panel (on «Схемы» at a diagram, when given). */
  show(diagram?: BriefDiagramKey): void;
  /** Re-reads the brief, and with the panel open its versions and sessions (after a server answer in the chat). */
  reload(): void;
  /** The short brief for the chat before «Собрать» (null without a brief). */
  summary: ReactNode;
  /** The panel over the canvas (null while closed). */
  panel: ReactNode;
}

export interface CanvasBriefOptions {
  /** Organization of the system: editing needs editor or owner (api.yaml editSystemBrief). */
  orgId?: string;
  /** «Изменить словами»: the canvas focuses its input row. */
  onAskInChat?(): void;
  /** Polite announcement for screen readers. */
  announce?(text: string): void;
}

const info = ({ brief: _brief, ...v }: BriefVersion): BriefVersionInfo => v;
const message = (e: unknown) => (e instanceof Error ? e.message : ru.errors.generic);

export function useCanvasBrief(systemId: string, o: CanvasBriefOptions = {}): CanvasBrief {
  const { api, auth, roleIn } = usePlatform();
  const [data, setData] = useState<Loaded | null>(null);
  const [versions, setVersions] = useState<BriefVersionInfo[]>([]);
  const [sessions, setSessions] = useState<SystemSession[] | null>(null);
  const [open, setOpen] = useState<{ tab: BriefPanelTab; diagram: BriefDiagramKey | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openRef = useRef(false);
  openRef.current = open !== null;
  const seen = useRef<number | null>(null);
  const announce = o.announce;

  const loadHistory = useCallback(async () => {
    const [v, ss] = await Promise.allSettled([api.listBriefVersions(systemId), api.listSessions(systemId)]);
    if (v.status === "fulfilled") setVersions(v.value.versions);
    if (ss.status === "fulfilled") setSessions(ss.value.sessions);
  }, [api, systemId]);

  const apply = useCallback(
    (brief: BriefVersion | null, diagrams: BriefDiagrams | null, quiet = false) => {
      if (!brief || !diagrams) return;
      const before = seen.current;
      seen.current = brief.version;
      setData({ brief, diagrams });
      if (!quiet && before !== null && brief.version !== before) {
        setNotice(briefRu.updated(brief.version));
        announce?.(briefRu.updated(brief.version));
      }
    },
    [announce],
  );

  /** quiet — the caller says itself why the brief changed (a conflict), no «Бриф обновлён». */
  const fetchBrief = useCallback(
    (quiet = false) => {
      void api
        .getBrief(systemId)
        .then((r) => {
          apply(r.brief, r.diagrams, quiet);
          if (r.brief && openRef.current) void loadHistory();
        })
        .catch(() => {
          // No brief route (v2 API) or a network blip: the canvas keeps what it has.
        });
    },
    [api, systemId, apply, loadHistory],
  );
  const reload = useCallback(() => fetchBrief(false), [fetchBrief]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened system
  useEffect(() => {
    seen.current = null;
    setData(null);
    reload();
  }, [systemId]);

  const isOpen = open !== null;
  useEffect(() => {
    if (isOpen) void loadHistory();
  }, [isOpen, loadHistory]);

  const show = useCallback((diagram?: BriefDiagramKey) => {
    setNotice(null);
    setSaveError(null);
    setOpen({ tab: diagram ? "diagrams" : "brief", diagram: diagram ?? null });
  }, []);
  const close = useCallback(() => setOpen(null), []);

  async function save(brief: SystemBrief, baseVersion: number) {
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const r = await api.saveBrief(systemId, { baseVersion, brief });
      apply(r.brief, r.diagrams, true);
      const v = r.brief?.version ?? baseVersion;
      const text = r.changed === false ? briefRu.unchanged : briefRu.saved(v);
      setNotice(text);
      announce?.(text);
      await loadHistory();
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
        setNotice(briefRu.conflict);
        fetchBrief(true);
      } else if (e instanceof ApiError && e.code === "VALIDATION_FAILED")
        setSaveError(briefRu.invalid(e.message));
      else setSaveError(message(e));
    } finally {
      setSaving(false);
    }
  }

  const editor = canEdit(roleIn(o.orgId), auth);
  const summary = data ? (
    <BriefSummary
      testId="canvas-brief-summary"
      brief={data.brief.brief}
      diagrams={data.diagrams}
      version={data.brief.version}
      onOpen={show}
    />
  ) : null;
  const panel =
    data && open ? (
      <BriefDrawer onClose={close}>
        <BriefPanel
          key={`${open.tab}:${open.diagram ?? ""}`}
          testId="canvas-brief-panel"
          brief={data.brief.brief}
          diagrams={data.diagrams}
          version={data.brief.version}
          author={data.brief.author}
          createdAt={data.brief.createdAt}
          versions={versions.length ? versions : [info(data.brief)]}
          sessions={sessions ?? []}
          initialTab={open.tab}
          initialDiagram={open.diagram}
          notice={notice}
          saving={saving}
          saveError={saveError}
          onClose={close}
          {...(editor ? { onSave: (b: SystemBrief, v: number) => void save(b, v) } : {})}
          {...(o.onAskInChat
            ? {
                onAskInChat: () => {
                  close();
                  // After the dialog has returned the focus to where it was: then to the input row.
                  setTimeout(() => o.onAskInChat?.(), 0);
                },
              }
            : {})}
        />
      </BriefDrawer>
    ) : null;
  return { available: data !== null, open: open !== null, show, reload, summary, panel };
}

/**
 * The panel as a dialog over the canvas: a floating card on the right on a wide screen, the whole screen on a phone.
 * Esc and a tap on the shade close it; focus moves in, stays in (Tab cycles) and returns to where it was.
 */
export function BriefDrawer({ onClose, children }: { onClose(): void; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('[data-testid="p-brief-close"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = [
        ...el.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // A press on the shade (outside the card) closes the panel.
    const layer = el?.parentElement;
    const onDown = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    layer?.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      layer?.removeEventListener("pointerdown", onDown);
      back?.focus?.();
    };
  }, [onClose]);
  return (
    <div className={s.layer} data-testid="canvas-brief">
      <div className={s.shade} aria-hidden="true" />
      <div ref={ref} className={s.sheet} role="dialog" aria-modal="true" aria-label={briefRu.dialog}>
        {children}
      </div>
    </div>
  );
}
