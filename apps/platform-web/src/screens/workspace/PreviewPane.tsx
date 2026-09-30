// Preview iframe per platform-screens.yaml#preview_contract: preview-url, role switch through the bridge,
// apply-theme-tokens without reload, reload policy (debounce 1 s, route and role kept), 2 s reply timeout → reload.
import { Button } from "@wizard/ui-kit";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import type { PreviewUrl, Theme } from "../../api/types.js";
import { usePlatform } from "../../app/context.js";
import { Pill } from "../../components/ui.js";
import { ru } from "../../i18n/ru.js";
import { type FromPreview, originOf, PreviewBridge, previewSrc } from "../../preview/bridge.js";
import { previewTokens } from "../../style/theme.js";
import s from "./Workspace.module.css";

export const PREVIEW_WIDTHS = [390, 768, 1280] as const;
const RELOAD_DEBOUNCE_MS = 1000;
const REFRESH_BEFORE_MS = 60_000;

const prefersDark = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;

export function PreviewPane({
  systemId,
  revision,
  available,
  theme,
  testData,
  toolbar,
}: {
  systemId: string;
  /** Newest preview revision (max of gate_result{G0, passed} and System.previewRevision); growth reloads. */
  revision: number;
  available: boolean;
  theme: Theme;
  testData: boolean;
  toolbar?: ReactNode;
}): ReactNode {
  const { api } = usePlatform();
  const [info, setInfo] = useState<PreviewUrl | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [role, setRole] = useState<string | null>(null);
  const [width, setWidth] = useState<(typeof PREVIEW_WIDTHS)[number]>(1280);
  const [notReady, setNotReady] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const infoRef = useRef(info);
  infoRef.current = info;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const routeRef = useRef("/");
  const roleRef = useRef(role);
  roleRef.current = role;
  const readyRef = useRef(false);
  const loadedOnce = useRef(false);
  // Revision in the mounted iframe and its mount generation: a reply that times out for an iframe that was
  // already replaced must not remount the new one.
  const shownRevision = useRef<number | null>(null);
  const generation = useRef(0);

  const reloadFrame = useCallback((next?: PreviewUrl) => {
    const i = next ?? infoRef.current;
    if (!i) return;
    readyRef.current = false;
    shownRevision.current = i.revision;
    generation.current++;
    setSrc(previewSrc(i.url, routeRef.current, i.revision));
    setNonce((n) => n + 1);
  }, []);

  /** Fallback reload on a reply timeout, only if the iframe the request went to is still mounted. */
  const reloadIfCurrent = useCallback(
    (gen: number, next?: PreviewUrl) => {
      if (gen === generation.current) reloadFrame(next);
    },
    [reloadFrame],
  );

  const sendTokens = useCallback(
    (bridge: PreviewBridge) => {
      if (!readyRef.current) return;
      const gen = generation.current;
      bridge
        .send({ type: "apply-theme-tokens", payload: previewTokens(themeRef.current, prefersDark()) }, true)
        .catch(() => reloadIfCurrent(gen));
    },
    [reloadIfCurrent],
  );

  const bridgeRef = useRef<PreviewBridge | null>(null);
  const bridge = useMemo(
    () =>
      new PreviewBridge({
        frame: () => frameRef.current,
        origin: () => (infoRef.current ? originOf(infoRef.current.url) : null),
        revision: () => infoRef.current?.revision ?? null,
        files: () => null,
        onMessage: (m: FromPreview) => {
          const b = bridgeRef.current;
          if (!b) return;
          switch (m.type) {
            case "ready":
              readyRef.current = true;
              routeRef.current = m.payload.route;
              if (m.payload.role) setRole(m.payload.role);
              setFrameError(null);
              sendTokens(b);
              break;
            case "route-changed":
              routeRef.current = m.payload.route;
              break;
            case "error":
              setFrameError(m.payload.message);
              break;
            default:
              break;
          }
        },
      }),
    [sendTokens],
  );
  bridgeRef.current = bridge;

  useEffect(() => bridge.start(window), [bridge]);

  // Theme edits go to the preview at once (D13), without a run or a reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme is read through themeRef; the effect fires on its change
  useEffect(() => {
    sendTokens(bridge);
  }, [theme, bridge, sendTokens]);

  const load = useCallback(
    async (r: string | null) => {
      try {
        const i = await api.getPreviewUrl(systemId, r ?? undefined);
        setNotReady(false);
        setInfo(i);
        infoRef.current = i;
        return i;
      } catch (e) {
        if (e instanceof ApiError && e.code === "PREVIEW_NOT_READY") setNotReady(true);
        return null;
      }
    },
    [api, systemId],
  );

  // Reload policy: new src when the revision grows, debounce 1 s (the first load is immediate). The iframe is
  // not remounted for a revision it already shows (route, role and unsaved style stay as they are).
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger itself
  useEffect(() => {
    if (!available) return;
    let live = true;
    const delay = loadedOnce.current ? RELOAD_DEBOUNCE_MS : 0;
    const t = setTimeout(async () => {
      const i = await load(roleRef.current);
      if (!i || !live) return;
      loadedOnce.current = true;
      if (i.revision !== shownRevision.current) reloadFrame(i);
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [available, revision, load, reloadFrame]);

  // M2 URLs carry a token with a TTL: re-read preview-url a minute before expiresAt (no reload).
  useEffect(() => {
    if (!info) return;
    const left = Date.parse(info.expiresAt) - Date.now() - REFRESH_BEFORE_MS;
    if (!Number.isFinite(left)) return;
    const t = setTimeout(() => void load(roleRef.current), Math.max(left, 5_000));
    return () => clearTimeout(t);
  }, [info, load]);

  async function switchRole(r: string) {
    if (r === roleRef.current) return;
    setRole(r);
    const i = await load(r);
    if (!i) return;
    if (!readyRef.current) {
      reloadFrame(i);
      return;
    }
    readyRef.current = false;
    const gen = generation.current;
    bridge
      .send({ type: "set-role", payload: { role: r, url: i.url } }, true)
      .catch(() => reloadIfCurrent(gen, i));
  }

  const roles = info?.roles ?? [];
  const address = info ? new URL(info.url).host : "";

  return (
    <div className={s.preview}>
      <div className={s.previewBar}>
        <span data-testid="preview-env">
          <Pill tone="warn" title={ru.preview.draftTitle}>
            {testData ? ru.preview.testData : ru.preview.draft}
          </Pill>
        </span>
        <span className={s.address}>{address}</span>
        <div className={s.tabs} role="tablist" aria-label={ru.preview.tabPreview}>
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className={s.tabOn}
            data-testid="preview-tab-preview"
          >
            {ru.preview.tabPreview}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="false"
            disabled
            title={ru.preview.tabLater}
            data-testid="preview-tab-code"
          >
            {ru.preview.tabCode}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="false"
            disabled
            title={ru.preview.tabLater}
            data-testid="preview-tab-data"
          >
            {ru.preview.tabData}
          </button>
        </div>
        <span className={s.spacer} />
        {toolbar}
      </div>
      <div className={s.previewBar}>
        {roles.length > 0 && (
          <fieldset className={s.segmented}>
            <legend className={s.muted}>{ru.preview.roles}:</legend>
            {roles.map((r) => (
              <button
                key={r.name}
                type="button"
                className={role === r.name ? s.segOn : s.seg}
                aria-pressed={role === r.name}
                data-testid={`role-switch-${r.name}`}
                onClick={() => void switchRole(r.name)}
              >
                {r.label ?? r.name}
              </button>
            ))}
          </fieldset>
        )}
        <span className={s.spacer} />
        <fieldset className={s.segmented}>
          <legend className={s.visuallyHidden}>{ru.preview.width}</legend>
          {PREVIEW_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              className={width === w ? s.segOn : s.seg}
              aria-pressed={width === w}
              data-testid={`preview-width-${w}`}
              onClick={() => setWidth(w)}
            >
              {ru.preview.widthLabel(w)}
            </button>
          ))}
        </fieldset>
      </div>
      {frameError && (
        <div role="alert" className={s.alertBox} data-testid="preview-error">
          <b>{ru.preview.failed}</b> <span>{frameError}</span>{" "}
          <Button size="sm" variant="secondary" onClick={() => reloadFrame()}>
            {ru.preview.reload}
          </Button>
        </div>
      )}
      <div className={s.frameWrap}>
        {src && available && !notReady ? (
          <iframe
            key={nonce}
            ref={frameRef}
            src={src}
            title={ru.preview.frameTitle}
            className={s.frame}
            style={{ width: `min(${width}px, 100%)` }}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            allow="camera"
            data-testid="preview-frame"
          />
        ) : (
          <div className={s.previewPending} data-testid="preview-pending">
            {ru.preview.pending}
          </div>
        )}
      </div>
    </div>
  );
}
