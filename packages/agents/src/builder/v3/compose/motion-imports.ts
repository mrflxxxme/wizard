// V4-06: motion/react names a section uses but does not import (DeepSeek's slip, rehearsal №6: `<m.div>` inside its own
// <LazyMotion> with `motion` imported — G0 TS2304 «Cannot find name 'm'» on every round left the home page as the
// skeleton). The page step adds them to the import before the page is assembled and checked.

/** Names and how a section uses them: `<m.x>`, the wrappers, `domAnimation` in their prop. */
const MOTION_NAMES: readonly [string, RegExp][] = [
  ["m", /<\/?m\.[a-zA-Z]/],
  ["LazyMotion", /<LazyMotion\b/],
  ["domAnimation", /features=\{domAnimation\}/],
  ["MotionConfig", /<MotionConfig\b/],
];

/** The source with every motion/react name it uses imported; unchanged when none is missing. */
export function withMotionImports(source: string): string {
  const imp = /import\s*\{([^}]*)\}\s*from\s*["']motion\/react["'];?/.exec(source);
  const names = (imp?.[1] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const have = new Set(names.map((x) => x.split(/\s+as\s+/)[1] ?? x));
  const missing = MOTION_NAMES.filter(([n, re]) => !have.has(n) && re.test(source)).map(([n]) => n);
  if (!missing.length) return source;
  if (!imp) return `import { ${missing.join(", ")} } from "motion/react";\n${source}`;
  return source.replace(imp[0], `import { ${[...names, ...missing].join(", ")} } from "motion/react";`);
}
