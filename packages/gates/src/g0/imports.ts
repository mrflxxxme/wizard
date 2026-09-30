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

const FIX_PACKAGES: Record<Area, string> = {
  functions: "В functions/** разрешены только @wizard/sdk и свои файлы из functions/",
  ui: "В ui/** разрешены только @wizard/sdk, @wizard/ui-kit и свои файлы из ui/; функции вызываются по имени через useQuery/useMutation",
};

export function checkImports(src: SourceInfo): Finding[] {
  const out: Finding[] = [];
  const fail = (line: number, message_ru: string, evidence: string, fixHint = FIX_PACKAGES[src.area]) =>
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
    if (!ALLOWED_PACKAGES[src.area].includes(s)) {
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
