// G0-IMP-01 (agents/builder.yaml#code_conventions.imports, security/isolation.yaml#static_checks_G0) and the
// import graph used by G0-SPEC-04.
import { posix } from "node:path";
import type { Finding } from "../report.js";
import { type Area, resolveRelative, type SourceInfo } from "./source.js";

/** Package specifiers generated code may import, per area. `@wizard/sdk/jsx-runtime` is part of the SDK (sdk.md §1.1). */
export const ALLOWED_PACKAGES: Readonly<Record<Area, readonly string[]>> = {
  functions: ["@wizard/sdk"],
  ui: ["@wizard/sdk", "@wizard/sdk/jsx-runtime", "@wizard/ui-kit"],
};

/**
 * Public pages of a v3 system (builder-v3.md §1, C3): pages, library patterns and signature sections may also import
 * React, Motion and the ui-kit headless hooks. A system is v3 when it carries the design system file ui/design.css
 * (the same marker switches Tailwind on in @wizard/build); v2 systems keep ALLOWED_PACKAGES.
 */
export const V3_UI_PACKAGES: readonly string[] = ["react", "motion/react", "@wizard/ui-kit/v3/headless"];
/** Files of a v3 system that may import V3_UI_PACKAGES. */
export const V3_UI_PATH_RE = /^ui\/(?:pages|patterns|sections)\//;

const FIX_PACKAGES: Record<Area, string> = {
  functions: "В functions/** разрешены только @wizard/sdk и свои файлы из functions/",
  ui: "В ui/** разрешены только @wizard/sdk, @wizard/ui-kit и свои файлы из ui/; функции вызываются по имени через useQuery/useMutation",
};
const FIX_V3 =
  "В ui/** разрешены только @wizard/sdk, @wizard/ui-kit и свои файлы из ui/; страницы, паттерны и секции сайта v3 (ui/pages, ui/patterns, ui/sections) — ещё react, motion/react и @wizard/ui-kit/v3/headless";

export interface ImportRules {
  /** The system is v3 (has ui/design.css): its public page files get V3_UI_PACKAGES. */
  v3?: boolean;
}

export function checkImports(src: SourceInfo, rules: ImportRules = {}): Finding[] {
  const out: Finding[] = [];
  const v3Page = rules.v3 === true && src.area === "ui" && V3_UI_PATH_RE.test(src.path);
  const fix = rules.v3 === true && src.area === "ui" ? FIX_V3 : FIX_PACKAGES[src.area];
  const fail = (line: number, message_ru: string, evidence: string, fixHint = fix) =>
    out.push({ message_ru, file: src.path, line, evidence, fixHint });
  for (const imp of src.imports) {
    const s = imp.specifier;
    if (imp.kind === "reference") {
      fail(
        imp.line,
        `Директива /// <reference> запрещена в ${src.path}`,
        `/// <reference … "${s}">`,
        "Удалите директиву: типы системы подключаются автоматически",
      );
      continue;
    }
    if (imp.hasAttributes) {
      fail(imp.line, `Импорт с атрибутами (with/assert) запрещён в ${src.path}`, s);
      continue;
    }
    if (/[?#]/.test(s)) {
      fail(imp.line, `Импорт с суффиксом запроса (?raw, ?url…) запрещён: «${s}»`, s);
      continue;
    }
    if (s.startsWith("./") || s.startsWith("../")) {
      const target = posix.normalize(posix.join(posix.dirname(src.path), s));
      if (!target.startsWith(`${src.area}/`)) {
        const msg =
          src.area === "ui" && target.startsWith("functions/")
            ? `Страница импортирует серверную функцию напрямую: «${s}»`
            : `Импорт выходит за пределы ${src.area}/: «${s}»`;
        fail(imp.line, msg, s);
      }
      continue;
    }
    if (!ALLOWED_PACKAGES[src.area].includes(s) && !(v3Page && V3_UI_PACKAGES.includes(s))) {
      fail(imp.line, `Запрещённый импорт «${s}» в ${src.path}`, s);
    }
  }
  return out;
}

/** Relative-import edges between system files (unresolvable imports are skipped). */
export function importGraph(
  sources: readonly SourceInfo[],
  files: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const src of sources) {
    const deps: string[] = [];
    for (const imp of src.imports) {
      if (imp.kind === "reference" || !imp.specifier.startsWith(".")) continue;
      const r = resolveRelative(src.path, imp.specifier, files);
      if (r) deps.push(r);
    }
    g.set(src.path, deps);
  }
  return g;
}

export function reachable(roots: Iterable<string>, graph: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of graph.get(cur) ?? []) stack.push(d);
  }
  return seen;
}
