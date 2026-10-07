// The canvas board (B2-25): frames «Сайт», «Кабинет», «Телефон» with the blocks of the client system, the x-ray layer
// over them and the data panel. Block states come from the screen (sketch → materializing → ready).
import { CanvasBlock, type CanvasBlockState, XrayLines, type XrayNode } from "@wizard/ui-kit/v2";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { canvas } from "../../i18n/ru/canvas.js";
import { BlockBody } from "./Blocks.js";
import s from "./Canvas.module.css";
import type { CanvasBlockModel, CanvasModel, FrameId } from "./model.js";
import type { XrayModel } from "./xray.js";

export type BoardView = "overview" | FrameId;

export interface BoardProps {
  model: CanvasModel;
  slug: string;
  view: BoardView;
  stateOf(id: string): CanvasBlockState;
  /** Stagger of a materializing block, ms. */
  delayOf(id: string): number;
  /** Blocks that changed with the last sketch («touch» glow) and blocks just born. */
  touched: ReadonlySet<string>;
  born: ReadonlySet<string>;
  xray: XrayModel | null;
  xrayVisible: boolean;
  selected: string | null;
  /** Ready blocks are pickable («ткни и скажи»). */
  onSelect?(b: CanvasBlockModel): void;
}

function Block({ b, p }: { b: CanvasBlockModel; p: BoardProps }): ReactNode {
  const state = p.stateOf(b.id);
  const pickable = state === "ready" && p.onSelect !== undefined;
  return (
    <div
      className={`${s.slotWrap} ${p.born.has(b.id) ? s.born : ""} ${p.touched.has(b.id) ? s.touch : ""}`}
      data-block-id={b.id}
      data-testid="canvas-block"
      data-kind={b.kind}
      data-block-state={state}
    >
      <CanvasBlock
        state={state}
        delayMs={state === "materializing" ? p.delayOf(b.id) : 0}
        label={canvas.pick.block(b.title)}
        selected={p.selected === b.id}
        testId={`canvas-block-${b.id}`}
        {...(pickable ? { onSelect: () => p.onSelect?.(b) } : {})}
      >
        <BlockBody b={b} />
      </CanvasBlock>
    </div>
  );
}

function Frame({ id, p, children }: { id: FrameId; p: BoardProps; children: ReactNode }): ReactNode {
  const blocks = p.model.frames[id];
  if (blocks.length === 0) return null;
  return (
    <div className={s.fw} data-f={id} data-testid={`canvas-frame-${id}`}>
      <div className={s.cap}>
        <span>{canvas.frames[id]}</span>
        <span className={s.grow} />
        <span className={s.sample}>{canvas.sample}</span>
      </div>
      {children}
    </div>
  );
}

export function Board(p: BoardProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 800 });
  const [nodes, setNodes] = useState<XrayNode[]>([]);
  const { model, xray } = p;

  // Anchor the x-ray steps to their blocks: centre of each block in board pixels; re-measured on resize. The board
  // zooms out so the whole chain fits between the top bar and the chat, and scrolls to it (prototype E zoomChain).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view or model moves the blocks — measure again
  useLayoutEffect(() => {
    const board = ref.current;
    if (!board) return;
    if (!xray || !p.xrayVisible) {
      board.style.removeProperty("--xs");
      return;
    }
    let xs = 1;
    const measure = (zoom: boolean) => {
      const r = board.getBoundingClientRect();
      const w = board.offsetWidth || 1;
      const h = board.offsetHeight || 1;
      const sc = r.width / w || 1;
      const raw = xray.steps.flatMap((st) => {
        const el = board.querySelector<HTMLElement>(`[data-block-id="${st.anchor}"]`);
        if (!el || el.offsetParent === null) return [];
        const b = el.getBoundingClientRect();
        return [
          {
            id: st.id,
            label: st.label,
            x: (b.left + b.width / 2 - r.left) / sc,
            y: (b.top + Math.min(b.height / 2, 90) - r.top) / sc,
          },
        ];
      });
      if (raw.length === 0) return setNodes([]);
      const ys = raw.map((n) => n.y);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      const top =
        (document.querySelector('[data-testid="canvas-top"]')?.getBoundingClientRect().bottom ?? 70) + 24;
      const narrow = innerWidth <= 600;
      // On the phone the data panel sits above the chat: the chain fits above it.
      const below = document.querySelector(
        narrow ? '[data-testid="canvas-xray-data"]' : '[data-testid="p-sheet-dock"]',
      );
      const bottom = (below?.getBoundingClientRect().top ?? innerHeight) - 24;
      if (zoom) {
        xs = Math.max(narrow ? 0.2 : 0.5, Math.min(1, (bottom - top) / (y1 - y0 + 80)));
        board.style.setProperty("--xs", xs.toFixed(3));
      }
      // Labels keep their size on the zoomed board: keep each one inside the board by its visible width.
      const labelWidth = (id: string) =>
        board.querySelector<HTMLElement>(`[data-testid="p-xray-node-${id}"]`)?.offsetWidth ?? 0;
      setSize({ w, h });
      setNodes(
        raw.map((n) => {
          const half = labelWidth(n.id) / 2 / xs + 4;
          return { ...n, x: half * 2 >= w ? w / 2 : Math.max(half, Math.min(w - half, n.x)) };
        }),
      );
      if (!zoom) return;
      const centre = r.top + window.scrollY + ((y0 + y1) / 2) * xs;
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({
        top: Math.max(0, centre - (top + bottom) / 2),
        behavior: reduce ? "auto" : "smooth",
      });
    };
    measure(true);
    // Second pass once the labels are on the page (their widths keep them inside the board).
    const raf = requestAnimationFrame(() => measure(false));
    if (typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(raf);
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(board);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [xray, p.xrayVisible, p.view, model]);

  const shown = new Set(nodes.map((n) => n.id));
  return (
    <div
      ref={ref}
      className={`${s.board} ${p.xrayVisible ? s.xr : ""}`}
      data-view={p.view}
      data-testid="canvas-board"
      data-stage={model.stage}
    >
      <Frame id="site" p={p}>
        <div className={`${s.frame} ${s.siteFrame}`}>
          <div className={s.browser} aria-hidden="true">
            <span className={s.dots}>
              <i />
              <i />
              <i />
            </span>
            {canvas.sampleData.domain(p.slug)}
          </div>
          <div className={s.site}>
            {model.frames.site.map((b) => (
              <Block key={b.id} b={b} p={p} />
            ))}
          </div>
        </div>
      </Frame>
      <Frame id="cab" p={p}>
        <div className={`${s.frame} ${s.cabFrame}`}>
          <div className={s.cTop} aria-hidden="true">
            <span className={s.cLogo} />
            <b>{canvas.frames.cab}</b>
            <span className={s.cDate}>{canvas.sampleData.date}</span>
          </div>
          <div className={s.cab}>
            {model.frames.cab.map((b) => (
              <Block key={b.id} b={b} p={p} />
            ))}
          </div>
        </div>
      </Frame>
      <Frame id="phone" p={p}>
        <div className={s.phone}>
          <div className={s.scr}>
            <div className={s.sbar} aria-hidden="true">
              <span>{canvas.sampleData.phoneTime}</span>
              <span className={s.isl} />
              <span className={s.bat} />
            </div>
            {model.frames.phone.map((b) => (
              <Block key={b.id} b={b} p={p} />
            ))}
          </div>
        </div>
      </Frame>
      {xray && (
        <XrayLines
          width={size.w}
          height={size.h}
          nodes={nodes}
          edges={xray.edges.filter(([a, b]) => shown.has(a) && shown.has(b))}
          visible={p.xrayVisible}
          testId="canvas-xray"
        />
      )}
    </div>
  );
}

/** «Кто видит данные» and «Сколько хранятся» next to the x-ray layer. */
export function XrayData({ xray }: { xray: XrayModel }): ReactNode {
  return (
    <aside className={s.xdata} aria-label={canvas.xray.data} data-testid="canvas-xray-data">
      {xray.access.length > 0 && (
        <>
          <h2>{canvas.xray.data}</h2>
          <ul>
            {xray.access.map((a) => (
              <li key={a.who}>
                <span>{a.who}</span>
                <b>{a.what}</b>
              </li>
            ))}
          </ul>
        </>
      )}
      {xray.retention.length > 0 && (
        <>
          <h2>{canvas.xray.keep}</h2>
          <ul>
            {xray.retention.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      {xray.automations.length > 0 && (
        <details className={s.autoList}>
          <summary>{canvas.xray.auto}</summary>
          <ul>
            {xray.automations.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </details>
      )}
      {xray.access.length === 0 && xray.retention.length === 0 && <p>{canvas.xray.none}</p>}
    </aside>
  );
}
