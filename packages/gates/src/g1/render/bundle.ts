// SSR bundle of ui/** for G1-RENDER-01 (gates.yaml#G1): one self-contained IIFE (react-dom/server, @wizard/sdk,
// @wizard/ui-kit, pages) evaluated by render/child.mjs inside a node:vm context. Same import rules as the system
// build (sdk.md §1.1); wz-ids come from @wizard/build injectWzIds, so the HTML carries the draft data-wz-id values.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { defaultHostModules, injectWzIds, type WzMap } from "@wizard/build";
import * as esbuild from "esbuild";

const NS = "wz-src";
const ENTRY = "wz-render-entry";
const SDK = "@wizard/sdk";
const SDK_JSX = "@wizard/sdk/jsx-runtime";
const UI_KIT = "@wizard/ui-kit";
const SOURCE_RE = /^ui\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.tsx?$/;

/**
 * Server render needs data in the first pass: useRemote (the one data path of every SDK hook) defers to
 * globalThis.__wzSsrRemote when the guest installs it (cache filled between passes, see child.mjs).
 */
const REMOTE_ANCHOR = /function useRemote<T>\([\s\S]*?\): RemoteState<T> & \{ refetch\(\): void \} \{\n/;
const REMOTE_HOOK =
  "  const __wzSsr = (globalThis as any).__wzSsrRemote;\n  if (__wzSsr) return __wzSsr(key, fetcher);\n";

export interface RenderBundle {
  ok: boolean;
  code: string;
  wzMap: WzMap;
  errors: string[];
}

function entryCode(pages: readonly string[]): string {
  return [
    `import { jsx } from ${JSON.stringify(SDK_JSX)};`,
    `import { SdkClient, SdkProvider, WizardError } from ${JSON.stringify(SDK)};`,
    `import { WzProvider } from ${JSON.stringify(UI_KIT)};`,
    `import { renderToString } from "react-dom/server";`,
    ...pages.map((f, i) => `import P${i} from ${JSON.stringify(`./${f}`)};`),
    `globalThis.__wzApp = { jsx, SdkClient, SdkProvider, WizardError, WzProvider, renderToString, pages: {${pages
      .map((f, i) => `${JSON.stringify(f)}: P${i}`)
      .join(", ")}} };`,
    "",
  ].join("\n");
}

export async function buildRenderBundle(
  spec: AppSpec,
  files: ReadonlyMap<string, string>,
): Promise<RenderBundle> {
  const sources = new Map<string, string>();
  const wzMap: WzMap = {};
  for (const [path, text] of files) {
    if (!SOURCE_RE.test(path) || path.endsWith(".d.ts")) continue;
    if (path.endsWith(".tsx")) {
      const t = injectWzIds(path, text);
      sources.set(path, t.code);
      for (const [id, e] of t.entries) wzMap[id] = e;
    } else sources.set(path, text);
  }
  const pages = [...new Set((spec.pages ?? []).map((p) => p.file))];
  const missing = pages.filter((f) => !sources.has(f));
  if (missing.length)
    return { ok: false, code: "", wzMap, errors: missing.map((f) => `Нет файла страницы ${f}`) };

  const host = defaultHostModules();
  const req = createRequire(import.meta.url);
  const reactDomServer = req.resolve("react-dom/server.browser");
  const sdkReact = join(dirname(host.sdk), "client", "react.tsx");

  const plugin: esbuild.Plugin = {
    name: "wizard-render",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: ENTRY, namespace: NS };
        if (args.namespace !== NS) {
          // Host packages: one SDK instance; everything else resolves normally from its own folder.
          if (args.path === SDK) return { path: host.sdk };
          if (args.path === SDK_JSX) return { path: host.sdkJsxRuntime };
          if (args.path === UI_KIT) return { path: host.uiKit };
          return undefined;
        }
        const fromEntry = args.importer === ENTRY;
        if (args.path === SDK) return { path: host.sdk };
        if (args.path === SDK_JSX) return { path: host.sdkJsxRuntime };
        if (args.path === UI_KIT) return { path: host.uiKit };
        if (fromEntry && args.path === "react-dom/server") return { path: reactDomServer };
        if (args.kind !== "import-statement" || !/^\.\.?\//.test(args.path) || /[?#\\\0]/.test(args.path))
          return { errors: [{ text: `Импорт «${args.path}» запрещён` }] };
        const base = posix.normalize(posix.join(fromEntry ? "." : posix.dirname(args.importer), args.path));
        if (!base.startsWith("ui/")) return { errors: [{ text: `Импорт «${args.path}» вне ui/` }] };
        for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`])
          if (sources.has(cand)) return { path: cand, namespace: NS };
        return { errors: [{ text: `Файл «${args.path}» не найден в ui/` }] };
      });
      build.onLoad({ filter: /.*/, namespace: NS }, (args) =>
        args.path === ENTRY
          ? { contents: entryCode(pages), loader: "js" }
          : { contents: sources.get(args.path) ?? "", loader: args.path.endsWith(".tsx") ? "tsx" : "ts" },
      );
      build.onLoad({ filter: /react\.tsx$/ }, (args) => {
        if (args.path !== sdkReact) return undefined;
        const src = readFileSync(args.path, "utf8");
        const m = REMOTE_ANCHOR.exec(src);
        if (!m) return { errors: [{ text: "@wizard/sdk: useRemote not found (G1-RENDER-01 hook)" }] };
        const at = m.index + m[0].length;
        return { contents: src.slice(0, at) + REMOTE_HOOK + src.slice(at), loader: "tsx" };
      });
    },
  };

  try {
    const r = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      outdir: "/wz-render-out",
      format: "iife",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: SDK,
      jsxDev: false,
      define: { "process.env.NODE_ENV": '"production"' },
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: SDK } },
      legalComments: "none",
      sourcemap: false,
      charset: "utf8",
      logLevel: "silent",
      loader: { ".woff2": "empty", ".woff": "empty", ".png": "empty", ".webp": "empty", ".svg": "empty" },
      plugins: [plugin],
    });
    const js = r.outputFiles.find((f) => f.path.endsWith(".js"));
    if (!js) return { ok: false, code: "", wzMap, errors: ["Сборка страниц не дала JS"] };
    return { ok: true, code: js.text, wzMap, errors: [] };
  } catch (e) {
    const errs = ((e as esbuild.BuildFailure).errors ?? []).map(
      (m) => `${m.location ? `${m.location.file}:${m.location.line}: ` : ""}${m.text}`,
    );
    return { ok: false, code: "", wzMap, errors: errs.length ? errs : [String((e as Error).message)] };
  }
}
