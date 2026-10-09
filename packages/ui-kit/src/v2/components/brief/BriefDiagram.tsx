import type { BriefGraph } from "@wizard/appspec";
import { type ReactNode, type RefObject, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx, type PBase, pRoot } from "../../util.js";
import s from "./BriefDiagram.module.css";
import { BRIEF_LAYOUT, type GraphLayout, layoutBriefGraph } from "./layout.js";

export interface BriefDiagramProps extends PBase {
  /** A graph of briefDiagrams (journey, dataRoles or integrations). */
  graph: BriefGraph;
  /** Russian name of the diagram («Путь клиента»): the caption and the accessible name. */
  title: string;
  /** Layout width, px; by default the width of the container (laid out again when it changes). */
  width?: number;
  /** A thumbnail without text for the short brief: shapes and lines only, hidden from screen readers. */
  mini?: boolean;
  /** Shows the title above the picture (default: true, not for a thumbnail). */
  caption?: boolean;
}

const MINI_WIDTH = 360;
const FALLBACK_WIDTH = 360;
const L = BRIEF_LAYOUT;

/** Width of the element rounded down to 8 px (small jitters do not re-lay out the graph). */
function useWidth(fixed: number | undefined): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fixed ?? FALLBACK_WIDTH);
  useLayoutEffect(() => {
    if (fixed !== undefined) {
      setW(fixed);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const cw = el.clientWidth;
      if (cw > 0) setW(Math.max(200, Math.floor(cw / 8) * 8));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  return [ref, w];
}

/** The shape of a graph for a thumbnail: short one-line boxes, no edge labels. */
const miniGraph = (g: BriefGraph): BriefGraph => ({
  nodes: g.nodes.map((n) => ({ ...n, label: n.kind === "scenario" ? "оооооооооо" : "ооооооо" })),
  edges: g.edges.map((e) => ({ ...e, label: "" })),
});

/** Baseline of line `i` inside a box starting at `top` (font sizes of the layout). */
const nodeBaseline = (top: number, i: number) => top + L.nodePadY + 12.6 + i * L.nodeLine;
const edgeBaseline = (top: number, i: number) => top + L.edgePadY + 10.9 + i * L.edgeLine;

function Picture({ layout, title, mini }: { layout: GraphLayout; title: string; mini: boolean }): ReactNode {
  const arrow = `p-brief-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // A tall graph in a landscape thumbnail is turned to flow left → right, so the whole of it stays visible.
  const turn = mini && layout.height > layout.width * 1.1;
  const [vw, vh] = turn ? [layout.height, layout.width] : [layout.width, layout.height];
  return (
    <svg
      className={cx(s.svg, mini && s.miniSvg)}
      width={mini ? undefined : layout.width}
      height={mini ? undefined : layout.height}
      viewBox={`0 0 ${vw} ${vh}`}
      preserveAspectRatio="xMidYMid meet"
      role={mini ? undefined : "img"}
      aria-label={mini ? undefined : title}
      aria-hidden={mini || undefined}
      data-testid="p-brief-svg"
    >
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path className={s.arrow} d="M0 1.2 9 5 0 8.8Z" />
        </marker>
      </defs>
      <g transform={turn ? `translate(0 ${layout.width}) rotate(-90)` : undefined}>
        <g className={s.edges}>
          {layout.edges.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              className={s.edge}
              d={e.d}
              markerEnd={e.reversed ? undefined : `url(#${arrow})`}
              markerStart={e.reversed ? `url(#${arrow})` : undefined}
            />
          ))}
        </g>
        {layout.nodes.map((n) => (
          <g
            key={n.id}
            className={cx(s.node, s[`k_${n.kind}`])}
            data-testid={mini ? undefined : `p-brief-node-${n.id}`}
            data-kind={n.kind}
          >
            <rect
              className={s.box}
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={n.kind === "actor" || n.kind === "role" ? Math.min(n.h / 2, 18) : 11}
            />
            {!mini && (
              <text className={s.text} x={n.x + n.w / 2} textAnchor="middle">
                {n.lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of one label never reorder
                  <tspan key={i} x={n.x + n.w / 2} y={nodeBaseline(n.y, i)}>
                    {line}
                  </tspan>
                ))}
              </text>
            )}
          </g>
        ))}
        {!mini &&
          layout.edges
            .filter((e) => e.lines.length > 0)
            .map((e) => (
              <g key={`${e.from}>${e.to}`} className={s.label} data-testid="p-brief-edge-label">
                <rect x={e.lx} y={e.ly} width={e.lw} height={e.lh} rx={7} />
                <text x={e.lx + e.lw / 2} textAnchor="middle">
                  {e.lines.map((line, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines of one label never reorder
                    <tspan key={i} x={e.lx + e.lw / 2} y={edgeBaseline(e.ly, i)}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            ))}
      </g>
    </svg>
  );
}

/**
 * A diagram of the brief drawn by our own code (D77 (9)): the layered layout of layout.ts in SVG, Russian labels,
 * readable on a 390 px phone (the layout follows the container), both themes through --p-* tokens. Screen readers get
 * the picture's name and the same graph as a list of words.
 */
export function BriefDiagram({
  graph,
  title,
  width,
  mini = false,
  caption = true,
  className,
  testId,
}: BriefDiagramProps): ReactNode {
  const [ref, measured] = useWidth(mini ? MINI_WIDTH : width);
  const layout = useMemo(
    () => layoutBriefGraph(mini ? miniGraph(graph) : graph, { width: measured }),
    [graph, measured, mini],
  );
  const labelOf = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.label])), [graph]);
  return (
    <figure
      {...pRoot("BriefDiagram", testId, "p-brief-diagram")}
      className={cx(s.fig, mini && s.mini, className)}
    >
      {caption && !mini && <figcaption className={s.cap}>{title}</figcaption>}
      <div ref={ref} className={s.frame} data-testid="p-brief-frame">
        <Picture layout={layout} title={title} mini={mini} />
      </div>
      {!mini && (
        <ul className={s.srOnly} aria-label={`${title} словами`}>
          {graph.nodes.map((n) => (
            <li key={n.id}>{n.label}</li>
          ))}
          {graph.edges.map((e) => (
            <li key={`${e.from}>${e.to}`}>
              {labelOf.get(e.from)} → {labelOf.get(e.to)}
              {e.label ? `: ${e.label}` : ""}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
