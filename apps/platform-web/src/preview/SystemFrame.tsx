// The live draft system on the whole canvas (V4-11, D79_v4 (8)): the real draft runtime in a frame at the real width of
// the window (or 390 px for «Телефон»). A new revision is loaded in a hidden second frame and shown only once it has
// loaded, so the owner never sees a half-built state; during a build new revisions are batched (one swap at most every
// BATCH_MS). Every frame and every «Открыть в новой вкладке» gets its own one-time preview URL: the login token of
// GET /systems/:id/preview-url is single-use (the runtime answers 404 replay to a second use).
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client.js";
import type { PreviewUrl } from "../api/types.js";
import { usePlatform } from "../app/context.js";
import { envelopeSchema, fromPreviewSchemas, previewSrc } from "./bridge.js";
import s from "./SystemFrame.module.css";

export type Device = "desktop" | "phone";

const RETRY_MS = 1500;
const RETRIES = 20;
/** A burst of revisions (a gate passes, the bundle follows) settles before the frame reloads. */
const DEBOUNCE_MS = 800;
/** During a build the frame changes at most this often: pages land in batches, not one by one. */
export const BATCH_MS = 12_000;
/** A frame that never reports load is shown anyway after this long (the runtime answered with an error page). */
const LOAD_TIMEOUT_MS = 20_000;
const ROUTE_RE = /^\/(?![/\\])/;

interface Slot {
  key: number;
  src: string;
  revision: number;
  loaded: boolean;
}

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

/**
 * Opens the draft in a new tab with a fresh one-time URL. The tab is opened synchronously in the click (no popup
 * blocker), then sent to the URL once the platform answers; it is closed when the URL cannot be had.
 */
export async function openPreviewTab(
  api: Pick<ApiClient, "getPreviewUrl">,
  systemId: string,
  route = "/",
): Promise<boolean> {
  const w = typeof window.open === "function" ? window.open("about:blank", "_blank") : null;
  try {
    const info = await api.getPreviewUrl(systemId);
    const href = previewSrc(info.url, ROUTE_RE.test(route) ? route : "/", info.revision);
    if (w) {
      w.opener = null;
      w.location.href = href;
    } else window.location.assign(href);
    return true;
  } catch {
    w?.close();
    return false;
  }
}

export interface SystemFrameProps {
  systemId: string;
  /** The newest revision with a preview (null — none yet). */
  revision: number | null;
  device: Device;
  /** A build runs: new revisions are batched. */
  batching?: boolean;
  /** Title of the frame for screen readers. */
  title: string;
  /** Shown while there is no revision or its URL. */
  placeholder: ReactNode;
  /** The route the owner is on inside the system (from the preview bridge), for «Открыть в новой вкладке». */
  onRoute?(route: string): void;
  testId?: string;
}

export function SystemFrame({
  systemId,
  revision,
  device,
  batching = false,
  title,
  placeholder,
  onRoute,
  testId = "canvas-frame",
}: SystemFrameProps): ReactNode {
  const { api } = usePlatform();
  const [slots, setSlots] = useState<Slot[]>([]);
  const route = useRef("/");
  const keySeq = useRef(0);
  const lastSwap = useRef(0);
  const wanted = useRef<number | null>(null);
  const frames = useRef(new Map<number, HTMLIFrameElement>());

  // Fetch a fresh URL for `rev` (retrying PREVIEW_NOT_READY) and start loading it in a new hidden slot.
  const load = useCallback(
    (rev: number, alive: () => boolean) => {
      const attempt = async (left: number): Promise<void> => {
        let info: PreviewUrl;
        try {
          info = await api.getPreviewUrl(systemId);
        } catch {
          if (!alive()) return;
          if (left > 0) {
            await new Promise((r) => setTimeout(r, RETRY_MS));
            if (alive()) return attempt(left - 1);
          }
          return;
        }
        if (!alive() || wanted.current !== rev) return;
        const src = previewSrc(info.url, route.current, info.revision);
        keySeq.current += 1;
        const key = keySeq.current;
        setSlots((cur) => {
          // Only the shown frame stays next to the new one; a frame still loading is dropped.
          const shown = cur.filter((x) => x.loaded).slice(-1);
          return [...shown, { key, src, revision: info.revision, loaded: false }];
        });
      };
      return attempt(RETRIES);
    },
    [api, systemId],
  );

  useEffect(() => {
    if (revision === null) return;
    let live = true;
    wanted.current = revision;
    const first = lastSwap.current === 0;
    const gap = batching && !first ? Math.max(0, lastSwap.current + BATCH_MS - Date.now()) : 0;
    const t = setTimeout(() => void load(revision, () => live), first ? 0 : Math.max(DEBOUNCE_MS, gap));
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [revision, batching, load]);

  const shown = useCallback((key: number) => {
    lastSwap.current = Date.now();
    setSlots((cur) => {
      const i = cur.findIndex((x) => x.key === key);
      if (i < 0) return cur;
      const next = cur[i] as Slot;
      return [{ ...next, loaded: true }];
    });
  }, []);

  // A frame that never fires load (an error page of the runtime still fires it; a hung one does not) is shown anyway.
  const pending = slots.find((x) => !x.loaded);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => shown(pending.key), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pending, shown]);

  // The bridge of the draft says which page the owner is on: a reload keeps it (exact origin and source checks).
  const visible = slots.find((x) => x.loaded);
  useEffect(() => {
    if (!visible) return;
    let origin: string;
    try {
      origin = new URL(visible.src).origin;
    } catch {
      return;
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frames.current.get(visible.key)?.contentWindow) return;
      const env = envelopeSchema.safeParse(e.data);
      if (!env.success || env.data.type !== "route-changed") return;
      const p = fromPreviewSchemas["route-changed"].safeParse(env.data.payload);
      if (!p.success) return;
      route.current = p.data.route;
      onRoute?.(p.data.route);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [visible, onRoute]);

  return (
    <div
      className={cx(s.stage, device === "phone" && s.phone)}
      data-device={device}
      data-testid={testId}
      data-revision={visible?.revision ?? undefined}
    >
      <div className={s.screen}>
        {slots.map((x) => (
          <iframe
            key={x.key}
            ref={(el) => {
              if (el) frames.current.set(x.key, el);
              else frames.current.delete(x.key);
            }}
            className={cx(s.frame, !x.loaded && s.loading)}
            src={x.src}
            title={title}
            aria-hidden={x.loaded ? undefined : true}
            tabIndex={x.loaded ? undefined : -1}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            data-testid={x.loaded ? `${testId}-site` : `${testId}-next`}
            data-revision={x.revision}
            onLoad={() => shown(x.key)}
          />
        ))}
        {!visible && (
          <div className={s.placeholder} data-testid={`${testId}-pending`}>
            {placeholder}
          </div>
        )}
      </div>
    </div>
  );
}
