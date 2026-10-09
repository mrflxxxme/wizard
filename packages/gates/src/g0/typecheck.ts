// G0-TS-01: in-process tsc (strict) of the revision against generateTypes(spec), @wizard/sdk (sdk.d.ts) and
// @wizard/ui-kit, with packages/build tsconfig.system (sdk.md §1.1). The revision lives in a virtual root holding
// only ui/**, functions/** and _generated/; the compiler host reads nothing else except the allowed type roots.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { type AppSpec, generateTypes } from "@wizard/appspec";
import { isTailwindSystem, systemTsconfig } from "@wizard/build";
import ts from "typescript";
import type { Finding } from "../report.js";
import { REPO_ROOT } from "./spec.js";

export const VIRTUAL_ROOT = "/__wizard_system__";
const GENERATED = `${VIRTUAL_ROOT}/_generated/wizard.d.ts`;

export interface TsDiagnostic extends Finding {
  /** Offset in the file, for mapping onto `where` ranges (G0-IDX-01). */
  start?: number;
  code: number;
}

/** ui-kit types: the self-contained ui-kit.d.ts when the package ships one, else its sources. */
export function uiKitTypesPath(): string {
  const entry = createRequire(import.meta.url).resolve("@wizard/ui-kit");
  const dts = join(dirname(entry), "ui-kit.d.ts");
  return existsSync(dts) ? dts : entry;
}

/**
 * Types of the packages the public pages of a v3 system may import (builder-v3.md §1, G0-IMP-01 V3_UI_PACKAGES):
 * React (@types/react next to the SDK), Motion (its own d.ts) and the ui-kit headless hooks (sources).
 */
export function v3TypePaths(): Record<string, string> {
  const req = createRequire(import.meta.url);
  const fromSdk = createRequire(req.resolve("@wizard/sdk"));
  const fromBuild = createRequire(req.resolve("@wizard/build"));
  const motionPkg = fromBuild.resolve("motion/package.json");
  const motion = JSON.parse(readFileSync(motionPkg, "utf8")) as {
    exports: Record<string, { types?: string }>;
  };
  const motionTypes = motion.exports["./react"]?.types;
  if (!motionTypes) throw new Error("motion: no types for motion/react");
  return {
    react: join(dirname(fromSdk.resolve("@types/react/package.json")), "index.d.ts"),
    "motion/react": join(dirname(motionPkg), motionTypes),
    "@wizard/ui-kit/v3/headless": req.resolve("@wizard/ui-kit/v3/headless"),
  };
}

const optionsCache = new Map<"v2" | "v3", ts.CompilerOptions>();
function compilerOptions(kind: "v2" | "v3"): ts.CompilerOptions {
  const hit = optionsCache.get(kind);
  if (hit) return hit;
  const cfg = systemTsconfig({ "@wizard/ui-kit": uiKitTypesPath(), ...(kind === "v3" ? v3TypePaths() : {}) });
  const parsed = ts.convertCompilerOptionsFromJson(cfg.compilerOptions, VIRTUAL_ROOT);
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; "),
    );
  }
  const options = { ...parsed.options, noEmit: true, incremental: false };
  optionsCache.set(kind, options);
  return options;
}

const LIB_DIR = dirname(ts.getDefaultLibFilePath({}));
const ALLOWED_ROOTS = [
  `${resolve(REPO_ROOT, "packages")}/`,
  `${resolve(REPO_ROOT, "node_modules")}/`,
  `${LIB_DIR}/`,
];
const inRoot = (p: string) => p === VIRTUAL_ROOT || p.startsWith(`${VIRTUAL_ROOT}/`);
const allowedHostPath = (p: string) => ALLOWED_ROOTS.some((r) => p.startsWith(r));

/** Library source files are immutable during a process lifetime: shared across runs. */
const libCache = new Map<string, ts.SourceFile>();
const sysCache = new Map<string, { text: string; sf: ts.SourceFile }>();
let lastProgram: { kind: "v2" | "v3"; program: ts.Program } | undefined;

function createHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
  const read = (p: string): string | undefined => {
    if (inRoot(p)) return files.get(p);
    return allowedHostPath(p) ? ts.sys.readFile(p) : undefined;
  };
  const dirs = new Set<string>([VIRTUAL_ROOT]);
  for (const p of files.keys())
    for (let d = dirname(p); d.startsWith(VIRTUAL_ROOT); d = dirname(d)) dirs.add(d);
  return {
    getSourceFile(fileName, languageVersion) {
      if (inRoot(fileName)) {
        const text = files.get(fileName);
        if (text === undefined) return undefined;
        const hit = sysCache.get(fileName);
        if (hit && hit.text === text) return hit.sf;
        const sf = ts.createSourceFile(fileName, text, languageVersion, true);
        sysCache.set(fileName, { text, sf });
        return sf;
      }
      const hit = libCache.get(fileName);
      if (hit) return hit;
      const text = read(fileName);
      if (text === undefined) return undefined;
      const sf = ts.createSourceFile(fileName, text, languageVersion, true);
      libCache.set(fileName, sf);
      return sf;
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (p) => (inRoot(p) ? files.has(p) : allowedHostPath(p) && ts.sys.fileExists(p)),
    readFile: read,
    directoryExists: (d) => (inRoot(d) ? dirs.has(d) : allowedHostPath(`${d}/`) && ts.sys.directoryExists(d)),
    getDirectories: (d) => (inRoot(d) ? [] : allowedHostPath(`${d}/`) ? ts.sys.getDirectories(d) : []),
    realpath: (p) => (inRoot(p) || !ts.sys.realpath ? p : ts.sys.realpath(p)),
  };
}

const HINT_TS =
  "Исправьте типы: используйте только поля, функции и индексы из описания системы (_generated/wizard.d.ts)";

export function typecheck(spec: AppSpec, systemFiles: ReadonlyMap<string, string>): TsDiagnostic[] {
  const files = new Map<string, string>();
  for (const [p, t] of systemFiles)
    if (/^(ui|functions)\/.+\.tsx?$/.test(p)) files.set(`${VIRTUAL_ROOT}/${p}`, t);
  files.set(GENERATED, generateTypes(spec));
  for (const k of sysCache.keys()) if (!files.has(k)) sysCache.delete(k);
  // v3 system (ui/design.css, as in @wizard/build): its public pages may import React, Motion and the headless hooks.
  const kind = isTailwindSystem(systemFiles) ? "v3" : "v2";
  const old = lastProgram?.kind === kind ? lastProgram.program : undefined;
  const program = ts.createProgram({
    rootNames: [...files.keys()].sort(),
    options: compilerOptions(kind),
    host: createHost(files),
    ...(old ? { oldProgram: old } : {}),
  });
  lastProgram = { kind, program };
  const out: TsDiagnostic[] = [];
  const push = (d: ts.Diagnostic) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    const rel =
      d.file && inRoot(d.file.fileName) ? d.file.fileName.slice(VIRTUAL_ROOT.length + 1) : undefined;
    const line =
      d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : undefined;
    out.push({
      code: d.code,
      message_ru: rel
        ? `Ошибка типов в ${rel}${line ? `:${line}` : ""} (TS${d.code})`
        : `Ошибка настройки проверки типов (TS${d.code})`,
      ...(rel ? { file: rel } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(d.start !== undefined ? { start: d.start } : {}),
      evidence: text,
      fixHint: HINT_TS,
    });
  };
  for (const d of program.getOptionsDiagnostics()) push(d);
  for (const d of program.getGlobalDiagnostics()) push(d);
  for (const sf of program.getSourceFiles()) {
    if (!inRoot(sf.fileName) || sf.fileName === GENERATED) continue;
    for (const d of program.getSyntacticDiagnostics(sf)) push(d);
    for (const d of program.getSemanticDiagnostics(sf)) push(d);
  }
  const gen = program.getSourceFile(GENERATED);
  if (gen)
    for (const d of [...program.getSyntacticDiagnostics(gen), ...program.getSemanticDiagnostics(gen)])
      push(d);
  return out;
}
