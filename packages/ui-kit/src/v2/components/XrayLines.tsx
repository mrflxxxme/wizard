import { type CSSProperties, type ReactNode, useLayoutEffect, useRef } from "react";
import { cx, type PBase, pRoot } from "../util.js";
import s from "./XrayLines.module.css";

export interface XrayPoint {
  x: number;
  y: number;
}

export interface XrayNode extends XrayPoint {
  id: string;
  /** Plain words: «Клиент записался», «Напоминание за день». */
  label: string;
}

/** Smooth cubic path between two points: vertical S-curve when the link is mostly vertical, horizontal otherwise. */
export function wirePath(p: XrayPoint, q: XrayPoint): string {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const r = (n: number) => Math.round(n * 10) / 10;
  return Math.abs(dy) > Math.abs(dx) * 0.6
    ? `M${r(p.x)} ${r(p.y)}C${r(p.x)} ${r(p.y + dy * 0.55)} ${r(q.x)} ${r(q.y - dy * 0.55)} ${r(q.x)} ${r(q.y)}`
    : `M${r(p.x)} ${r(p.y)}C${r(p.x + dx * 0.55)} ${r(p.y)} ${r(q.x - dx * 0.55)} ${r(q.y)} ${r(q.x)} ${r(q.y)}`;
}

export interface XrayLinesProps extends PBase {
  /** Size of the layer in the same units as the node coordinates (usually the canvas board in px). */
  width: number;
  height: number;
  /** Steps of the automation chain, numbered in order. */
  nodes: readonly XrayNode[];
  /** Links between node ids. */
  edges: readonly (readonly [string, string])[];
  visible: boolean;
}

/** X-ray layer «Как это работает»: numbered steps in plain words and thin lines between them over the canvas. */
export function XrayLines({
  width,
  height,
  nodes,
  edges,
  visible,
  className,
  testId,
}: XrayLinesProps): ReactNode {
  const at = new Map(nodes.map((n) => [n.id, n]));
  const ref = useRef<HTMLDivElement>(null);
  // Keep every label inside the layer: centre on its point, clamped by its own width (no horizontal page scroll).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the labels are re-measured in the DOM when the nodes change
  useLayoutEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const place = () => {
      const w = layer.clientWidth;
      for (const li of layer.querySelectorAll<HTMLElement>("li[data-x]")) {
        const half = li.offsetWidth / 2 + 2;
        const x = (Number(li.dataset.x) / width) * w;
        li.style.left = `${Math.max(half, Math.min(w - half, x))}px`;
      }
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(layer);
    return () => ro.disconnect();
  }, [nodes, width]);
  return (
    <div
      ref={ref}
      {...pRoot("XrayLines", testId, "p-xray")}
      data-visible={visible || undefined}
      aria-hidden={!visible}
      className={cx(s.layer, visible && s.on, className)}
    >
      <svg
        className={s.wires}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {edges.map(([a, b]) => {
          const p = at.get(a);
          const q = at.get(b);
          if (!p || !q) return null;
          const d = wirePath(p, q);
          return (
            <g key={`${a}-${b}`}>
              <path className={s.base} d={d} />
              <path className={s.flow} d={d} />
            </g>
          );
        })}
      </svg>
      <ol className={s.list} aria-label="Как это работает">
        {nodes.map((n, i) => (
          <li
            key={n.id}
            className={s.node}
            data-testid={`p-xray-node-${n.id}`}
            data-x={n.x}
            style={
              {
                left: `${(n.x / width) * 100}%`,
                top: `${(n.y / height) * 100}%`,
                "--p-i": i,
              } as CSSProperties
            }
          >
            <span className={s.num} aria-hidden="true">
              {i + 1}
            </span>
            {n.label}
          </li>
        ))}
      </ol>
    </div>
  );
}
