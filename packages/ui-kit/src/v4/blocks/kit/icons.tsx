// Lucide icons (ISC, © Lucide Contributors; THIRD_PARTY_NOTICES.md): the drawing data of the icons the blocks offer,
// inlined so a page ships only the icons it uses. 24×24, stroke 2, round caps — the Lucide grid.
import type { ReactElement } from "react";

type Shape = ["path", { d: string }] | ["circle", { cx: number; cy: number; r: number }] | ["rect", Rect];
type Rect = { x: number; y: number; width: number; height: number; rx: number };
const p = (...d: string[]): Shape[] => d.map((x) => ["path", { d: x }]);
const c = (cx: number, cy: number, r: number): Shape => ["circle", { cx, cy, r }];

const DATA = {
  check: p("M20 6 9 17l-5-5"),
  "arrow-right": p("M5 12h14", "m12 5 7 7-7 7"),
  "arrow-up-right": p("M7 7h10v10", "M7 17 17 7"),
  star: p(
    "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
  ),
  phone: p(
    "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z",
  ),
  mail: [
    ["rect", { x: 2, y: 4, width: 20, height: 16, rx: 2 }],
    ...p("m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"),
  ],
  "map-pin": [...p("M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"), c(12, 10, 3)],
  clock: [c(12, 12, 10), ...p("M12 6v6l4 2")],
  "shield-check": p(
    "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
    "m9 12 2 2 4-4",
  ),
  sparkles: p(
    "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
    "M20 3v4",
    "M22 5h-4",
    "M4 17v2",
    "M5 18H3",
  ),
  zap: p(
    "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
  ),
  heart: p(
    "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
  ),
  users: [
    ...p(
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
      "M22 21v-2a4 4 0 0 0-3-3.87",
      "M16 3.13a4 4 0 0 1 0 7.75",
    ),
    c(9, 7, 4),
  ],
  leaf: p(
    "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z",
    "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12",
  ),
  truck: [
    ...p(
      "M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2",
      "M15 18H9",
      "M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14",
    ),
    c(17, 18, 2),
    c(7, 18, 2),
  ],
  calendar: [...p("M8 2v4", "M16 2v4", "M3 10h18"), ["rect", { x: 3, y: 4, width: 18, height: 18, rx: 2 }]],
  "chevron-down": p("m6 9 6 6 6-6"),
  plus: p("M5 12h14", "M12 5v14"),
  menu: p("M4 6h16", "M4 12h16", "M4 18h16"),
  x: p("M18 6 6 18", "m6 6 12 12"),
  quote: p(
    "M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
    "M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
  ),
  award: [
    ...p(
      "m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526",
    ),
    c(12, 8, 6),
  ],
  wrench: p(
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  ),
  coffee: p(
    "M10 2v2",
    "M14 2v2",
    "M6 2v2",
    "M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1",
  ),
  scissors: [c(6, 6, 3), c(6, 18, 3), ...p("M8.12 8.12 12 12", "M20 4 8.12 15.88", "M14.8 14.8 20 20")],
  home: p(
    "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",
    "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  ),
  "message-circle": p("M7.9 20A9 9 0 1 0 4 16.1L2 22Z"),
  send: p(
    "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
    "m21.854 2.147-10.94 10.939",
  ),
  smile: [c(12, 12, 10), ...p("M8 14s1.5 2 4 2 4-2 4-2", "M9 9h.01", "M15 9h.01")],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof DATA;
/** Every icon name a slot may hold. */
export const ICON_NAMES = Object.keys(DATA) as [IconName, ...IconName[]];

/** A Lucide icon; decorative (aria-hidden) unless a label is given. */
export function Icon({ name, className, label }: { name: IconName; className?: string; label?: string }) {
  const shapes: ReactElement[] = DATA[name].map(([tag, attrs], i) => {
    const key = `${tag}${i}`;
    if (tag === "path") return <path key={key} {...attrs} />;
    if (tag === "circle") return <circle key={key} {...attrs} />;
    return <rect key={key} {...attrs} />;
  });
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-6"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {shapes}
    </svg>
  );
}
