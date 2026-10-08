// L3-13 resolver (specs/security/isolation.yaml#static_checks_G0.build, sdk.md §1.1): code of the
// revision copy may import only @wizard/sdk, @wizard/ui-kit and its own ui/** or functions/** files.
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Loader, OnResolveResult, Plugin } from "esbuild";
import type { HostModules } from "./types.js";

export const ENTRY_NS = "wz-entry";
export const SDK = "@wizard/sdk";
export const SDK_JSX = "@wizard/sdk/jsx-runtime";
export const UI_KIT = "@wizard/ui-kit";

export type Area = "ui" | "functions";

export interface PluginOptions {
  target: "client" | "functions";
  copyDir: string;
  /** Loaded sources by system-relative posix path (already wz-id transformed for ui/**). */
  sources: ReadonlyMap<string, string>;
  entryCode: string;
  host: HostModules;
  /** Bare imports also allowed in ui/** of the client (v3 systems, builder-v3.md C3): specifier → absolute file. */
  packages?: ReadonlyMap<string, string>;
}

const SOURCE_LOADERS: Record<string, Loader> = { ".ts": "ts", ".tsx": "tsx" };

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function inside(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function reject(text: string): OnResolveResult {
  return { errors: [{ text }] };
}

const ALLOWED_RU = "разрешены только @wizard/sdk, @wizard/ui-kit (в ui/**) и файлы своей папки";

export function wizardPlugin(o: PluginOptions): Plugin {
  const entryArea: Area = o.target === "client" ? "ui" : "functions";
  const extra = o.target === "client" ? o.packages : undefined;
  const allowedRu = extra?.size
    ? `разрешены только @wizard/sdk, @wizard/ui-kit, ${[...extra.keys()].join(", ")} (в ui/**) и файлы своей папки`
    : ALLOWED_RU;
  const areaOf = (abs: string): Area | null => {
    if (!inside(o.copyDir, abs)) return null;
    const top = toPosix(relative(o.copyDir, abs)).split("/")[0];
    return top === "ui" || top === "functions" ? top : null;
  };

  const resolveUser = (
    spec: string,
    area: Area,
    resolveDir: string,
    kind: string,
    fromEntry: boolean,
    attrs: Record<string, string>,
  ): OnResolveResult => {
    const what = `Импорт «${spec}» запрещён`;
    if (kind !== "import-statement" && kind !== "entry-point") {
      return reject(`${what}: только статический import (${kind})`);
    }
    if (Object.keys(attrs).length > 0) return reject(`${what}: import attributes не допускаются`);
    if (spec === SDK) {
      return o.target === "functions" ? { path: SDK, external: true } : { path: o.host.sdk };
    }
    if (spec === SDK_JSX && area === "ui") return { path: o.host.sdkJsxRuntime };
    if (spec === UI_KIT && area === "ui") return { path: o.host.uiKit };
    if (fromEntry && spec === "react-dom/client" && o.target === "client") {
      return { path: o.host.reactDomClient };
    }
    const pkg = area === "ui" ? extra?.get(spec) : undefined;
    if (pkg) return { path: pkg };
    if (!spec.startsWith("./") && !spec.startsWith("../")) return reject(`${what}: ${allowedRu}`);
    if (/[?#\\\0]/.test(spec)) return reject(`${what}: суффиксы запроса (?raw, ?url) не допускаются`);
    const base = resolve(resolveDir, spec);
    const areaDir = join(o.copyDir, area);
    if (!inside(areaDir, base)) return reject(`${what}: путь выходит за пределы ${area}/ — ${allowedRu}`);
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (o.sources.has(toPosix(relative(o.copyDir, cand)))) return { path: cand };
    }
    return reject(`Файл «${spec}» не найден в ${area}/ (допустимы только .ts и .tsx)`);
  };

  return {
    name: "wizard-system",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: o.target, namespace: ENTRY_NS };
        if (args.namespace === ENTRY_NS) {
          return resolveUser(args.path, entryArea, o.copyDir, args.kind, true, args.with);
        }
        const area = areaOf(args.importer);
        if (area) return resolveUser(args.path, area, args.resolveDir, args.kind, false, args.with);
        if (inside(o.copyDir, args.importer)) return reject(`Импорт из файла вне ui/** и functions/**`);
        // Host packages (sdk, ui-kit, react): one SDK instance, default resolution for the rest.
        if (args.path === SDK) return { path: o.host.sdk };
        if (args.path === SDK_JSX) return { path: o.host.sdkJsxRuntime };
        if (args.path === UI_KIT) return { path: o.host.uiKit };
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: ENTRY_NS }, () => ({
        contents: o.entryCode,
        loader: "js",
        resolveDir: o.copyDir,
      }));

      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        if (!inside(o.copyDir, args.path)) return undefined;
        const rel = toPosix(relative(o.copyDir, args.path));
        const loader = SOURCE_LOADERS[extname(rel)];
        const contents = o.sources.get(rel);
        if (!loader || contents === undefined) {
          return { errors: [{ text: `Файл «${rel}» нельзя включить в сборку: только .ts и .tsx` }] };
        }
        return { contents, loader };
      });
    },
  };
}
