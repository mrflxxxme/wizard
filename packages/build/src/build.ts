// buildSystem (specs/architecture.yaml#interfaces.build_system): the only build of system code.
// Runs in a throwaway copy of the revision (absWorkingDir) holding just ui/** and functions/**.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSpec } from "@wizard/appspec";
import * as esbuild from "esbuild";
import { canonicalJson, sha256Hex, specHash } from "./hash.js";
import { ENTRY_NS, SDK, SDK_JSX, toPosix, UI_KIT, wizardPlugin } from "./plugin.js";
import { parseSeo, SEO_PATH, type SiteSeo, seoClientCode, seoHeadTags, seoTitle } from "./seo.js";
import { DESIGN_CSS_PATH, layeredCss, systemTailwind } from "./tailwind.js";
import type {
  BuildEnv,
  BuildInput,
  BuildManifest,
  BuildResult,
  Check,
  HostModules,
  V3HostModules,
} from "./types.js";
import { injectWzIds, type WzMap } from "./wz-id.js";

export const BUILD_CHECK_ID = "G0-BUILD-01";
/** gates.yaml#G0.limits. */
export const UI_BUNDLE_LIMIT = 2 * 1024 * 1024;
export const SYSTEM_BUNDLE_LIMIT = 5 * 1024 * 1024;

const SOURCE_PATH_RE =
  /^(ui|functions)\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.tsx?$/;
const DECL_RE = /\.d\.ts$/;

export function defaultHostModules(): HostModules {
  const req = createRequire(import.meta.url);
  return {
    sdk: req.resolve(SDK),
    sdkJsxRuntime: req.resolve(SDK_JSX),
    uiKit: req.resolve("@wizard/ui-kit"),
    reactDomClient: req.resolve("react-dom/client"),
  };
}

/** React, Motion (ESM entry of motion/react) and the ui-kit headless hooks for the UI of v3 systems. */
export function defaultV3HostModules(): V3HostModules {
  const req = createRequire(import.meta.url);
  const motionPkg = req.resolve("motion/package.json");
  const entry = (
    JSON.parse(readFileSync(motionPkg, "utf8")) as { exports: Record<string, { import: string }> }
  ).exports["./react"]?.import;
  if (!entry) throw new Error("motion: no ESM entry for motion/react");
  let headless: string | null = null;
  try {
    headless = req.resolve("@wizard/ui-kit/v3/headless");
  } catch {
    headless = null; // ui-kit has no headless hooks yet (V3-10)
  }
  return {
    react: req.resolve("react"),
    motionReact: join(dirname(motionPkg), entry),
    uiKitHeadless: headless,
  };
}

function v3Packages(m: V3HostModules): Map<string, string> {
  const out = new Map([
    ["react", m.react],
    ["motion/react", m.motionReact],
  ]);
  if (m.uiKitHeadless) out.set("@wizard/ui-kit/v3/headless", m.uiKitHeadless);
  return out;
}

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** "../../home/…/wizard/" as esbuild prints it from the copy dir; null if there is no safe common root. */
function hostPathPrefix(copyDir: string, hostPaths: readonly string[]): string | null {
  let root = realpathSync(WORKSPACE_ROOT);
  for (const p of hostPaths) {
    const real = realpathSync(p);
    while (!real.startsWith(root + sep)) {
      const up = dirname(root);
      if (up === root) return null;
      root = up;
    }
  }
  const rel = toPosix(relative(copyDir, root));
  return rel.split("/").some((s) => s !== "..") ? `${rel}/` : null;
}

function fail(message_ru: string, extra: Partial<Check> = {}): Check {
  return { id: BUILD_CHECK_ID, status: "fail", severity: "blocker", message_ru, ...extra };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function fromEsbuild(m: esbuild.Message): Check {
  const file = m.location?.file.replace(/^file:/, "");
  const where = file ? ` (${file}${m.location ? `:${m.location.line}` : ""})` : "";
  return fail(clip(`Код системы не собирается${where}`, 300), {
    ...(file ? { file } : {}),
    ...(m.location ? { line: m.location.line } : {}),
    evidence: clip(m.text, 500),
    fixHint:
      "Исправьте импорт или синтаксис в указанном файле; разрешены только @wizard/sdk, @wizard/ui-kit и свои файлы",
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function validOrigin(o: string): boolean {
  try {
    const u = new URL(o);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === o;
  } catch {
    return false;
  }
}

function clientEntry(spec: AppSpec, seo: SiteSeo | null): string {
  const pages = [...(spec.pages ?? [])];
  const lines = [
    // v3 (ui/seo.json): the tags of the current route on start and on navigation (seo.ts).
    ...(seo ? [seoClientCode(seo)] : []),
    `import { jsx } from ${JSON.stringify(SDK_JSX)};`,
    `import { SdkProvider, matchRoute, useEffect, useState } from ${JSON.stringify(SDK)};`,
    `import { AppShell, WzProvider } from ${JSON.stringify(UI_KIT)};`,
    `import { createRoot } from "react-dom/client";`,
    ...pages.map((p, i) => `import P${i} from ${JSON.stringify(`./${p.file}`)};`),
    `const pages = [${pages.map((p, i) => `[${JSON.stringify(p.route)}, P${i}]`).join(", ")}];`,
    "const routes = pages.map((p) => p[0]);",
    // Static segments win over params (same order as useParams in the SDK).
    'const ordered = [...pages].sort((a, b) => a[0].split(":").length - b[0].split(":").length);',
    "function App({ spec }) {",
    "  const [path, setPath] = useState(window.location.pathname);",
    "  useEffect(() => {",
    "    const on = () => setPath(window.location.pathname);",
    '    window.addEventListener("popstate", on);',
    '    return () => window.removeEventListener("popstate", on);',
    "  }, []);",
    "  const hit = ordered.find((p) => matchRoute(p[0], path));",
    ...(seo ? ["  useEffect(() => __wzSeo(hit ? hit[0] : null), [path]);"] : []),
    // /login is reserved (runtime.yaml#auth.login_page): no page takes it; AppShell renders AppShell.Login there.
    '  const page = hit ? jsx(hit[1], {}) : path === "/login" ? jsx(AppShell, { children: null }) : jsx("main", { "data-testid": "wz-not-found", children: "Страница не найдена" });',
    "  return jsx(SdkProvider, { routes, children: jsx(WzProvider, { spec, children: page }) });",
    "}",
    // ui-kit.yaml#data_binding.provider: the template mounts WzProvider with the session RoleSpec;
    // a role change reloads the page (login, set-role), so one read at start is enough.
    'fetch("/_wizard/spec", { credentials: "same-origin", headers: { accept: "application/json" } })',
    '  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("/_wizard/spec " + r.status))))',
    // The runtime RoleSpec is ui-kit's RoleSpec (one contract, FU-4): passed through as is.
    '  .then((spec) => createRoot(document.getElementById("root")).render(jsx(App, { spec })));',
    "",
  ];
  return lines.join("\n");
}

function functionsEntry(spec: AppSpec): string {
  const fns = [...(spec.functions ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    ...fns.map((f, i) => `import F${i} from ${JSON.stringify(`./${f.file}`)};`),
    ...fns.map((f, i) => `export { F${i} as ${f.name} };`),
    `export default { ${fns.map((f, i) => `${JSON.stringify(f.name)}: F${i}`).join(", ")} };`,
    "",
  ].join("\n");
}

function indexHtml(
  spec: AppSpec,
  env: BuildEnv,
  script: string,
  style: string | null,
  origin?: string,
  seo: SiteSeo | null = null,
): string {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(seo ? seoTitle(seo) : spec.app.name)}</title>`,
    // One document serves every route (runtime SPA fallback): crawlers read the home page's tags.
    ...(seo ? seoHeadTags(seo) : []),
    ...(env === "draft" && origin
      ? [`<meta name="wz-platform-origin" content="${escapeHtml(origin)}">`]
      : []),
    ...(style ? [`<link rel="stylesheet" href="/${style}">`] : []),
    ...(env === "draft" ? ['<script src="/_wizard/bridge.js"></script>'] : []),
    `<script type="module" src="/${script}"></script>`,
  ];
  return `<!doctype html>\n<html lang="ru">\n<head>\n${head.join("\n")}\n</head>\n<body>\n<div id="root"></div>\n</body>\n</html>\n`;
}

function emptyManifest(spec: AppSpec, env: BuildEnv): BuildManifest {
  return {
    format: 1,
    env,
    specHash: specHash(spec),
    bundleKey: null,
    contentHash: "",
    entry: { script: "", style: null },
    client: {},
    functions: { file: "server/functions.mjs", sha256: "", names: [] },
    wzMap: false,
    sizes: { client: 0, functions: 0 },
    esbuild: esbuild.version,
  };
}

export async function buildSystem(input: BuildInput): Promise<BuildResult> {
  const { spec, env } = input;
  const errors: Check[] = [];
  const failed = (): BuildResult => ({
    ok: false,
    errors,
    client: new Map(),
    serverFunctions: "",
    wzMap: null,
    manifest: emptyManifest(spec, env),
    spec,
  });

  if (env !== "draft" && env !== "prod") errors.push(fail(`Неизвестное окружение сборки: ${String(env)}`));
  if (input.platformOrigin !== undefined && !validOrigin(input.platformOrigin)) {
    errors.push(
      fail("Адрес платформы для превью задан неверно", { evidence: clip(input.platformOrigin, 200) }),
    );
  }

  // Only ui/** and functions/** .ts/.tsx reach the copy; .env, _generated/, assets/ never do (L3-13).
  const sources = new Map<string, string>();
  for (const [path, text] of [...input.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!/^(ui|functions)\/.*\.tsx?$/.test(path)) continue;
    if (!SOURCE_PATH_RE.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
      errors.push(fail(`Недопустимое имя файла «${clip(path, 120)}»`, { file: clip(path, 200) }));
      continue;
    }
    if (DECL_RE.test(path)) continue;
    sources.set(path, text);
  }
  for (const p of spec.pages ?? []) {
    if (!sources.has(p.file)) errors.push(fail(`Нет файла страницы ${p.file}`, { file: p.file }));
  }
  for (const f of spec.functions ?? []) {
    if (!sources.has(f.file)) errors.push(fail(`Нет файла функции ${f.file}`, { file: f.file }));
  }
  // Per-route SEO of v3 pages (V3-12): the page composer writes ui/seo.json.
  let seo: SiteSeo | null = null;
  const seoText = input.files.get(SEO_PATH);
  if (seoText !== undefined) {
    const parsed = parseSeo(seoText);
    if (parsed.ok) seo = parsed.seo;
    else
      errors.push(
        fail(`SEO страниц (${SEO_PATH}) записано неверно: ${clip(parsed.error, 200)}`, {
          file: SEO_PATH,
          fixHint: "Пересоберите страницы сайта: файл пишет сборщик страниц v3",
        }),
      );
  }
  if (errors.length > 0) return failed();

  const loaded = new Map<string, string>();
  const wzMap: WzMap = {};
  for (const [path, text] of sources) {
    if (path.startsWith("ui/") && path.endsWith(".tsx")) {
      const t = injectWzIds(path, text);
      loaded.set(path, t.code);
      for (const [id, e] of t.entries) wzMap[id] = e;
    } else loaded.set(path, text);
  }

  const host = { ...defaultHostModules(), ...input.hostModules };
  // v3 system (builder-v3.md §1): Tailwind over ui/design.css runs next to esbuild; React and Motion are importable.
  const v3Host = input.files.has(DESIGN_CSS_PATH)
    ? { ...defaultV3HostModules(), ...input.v3HostModules }
    : null;
  const tailwind = v3Host ? systemTailwind(input.files) : null;
  const copyDir = realpathSync(mkdtempSync(join(tmpdir(), "wz-build-")));
  try {
    for (const [path, text] of sources) {
      mkdirSync(dirname(join(copyDir, path)), { recursive: true });
      writeFileSync(join(copyDir, path), text);
    }
    const common: esbuild.BuildOptions = {
      absWorkingDir: copyDir,
      bundle: true,
      write: false,
      outdir: join(copyDir, "out"),
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      jsxImportSource: SDK,
      jsxDev: false,
      // No host env reaches the bundle; only a constant for React's build switch.
      define: { "process.env.NODE_ENV": '"production"' },
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: SDK } },
      legalComments: "none",
      sourcemap: false,
      charset: "utf8",
      logLevel: "silent",
    };
    const run = (opts: esbuild.BuildOptions) =>
      esbuild.build(opts).then(
        (r) => ({ files: r.outputFiles ?? [], errors: [] as esbuild.Message[] }),
        (e: unknown) => ({
          files: [] as esbuild.OutputFile[],
          errors: (e as esbuild.BuildFailure).errors ?? [],
        }),
      );
    const [client, fns] = await Promise.all([
      run({
        ...common,
        entryPoints: [{ in: `${ENTRY_NS}:client`, out: "index" }],
        platform: "browser",
        // Whitespace minification also drops `// <path>` module comments: no host paths in the bundle,
        // the same output wherever the repo lives. prod additionally minifies identifiers and syntax.
        minifyWhitespace: true,
        minifyIdentifiers: env === "prod",
        minifySyntax: env === "prod",
        entryNames: "assets/[name]",
        assetNames: "assets/[name]-[hash]",
        loader: { ".woff2": "file", ".woff": "file", ".png": "file", ".webp": "file" },
        plugins: [
          wizardPlugin({
            target: "client",
            copyDir,
            sources: loaded,
            entryCode: clientEntry(spec, seo),
            host,
            ...(v3Host ? { packages: v3Packages(v3Host) } : {}),
          }),
        ],
      }),
      run({
        ...common,
        entryPoints: [{ in: `${ENTRY_NS}:functions`, out: "functions" }],
        platform: "neutral",
        plugins: [
          wizardPlugin({
            target: "functions",
            copyDir,
            sources: loaded,
            entryCode: functionsEntry(spec),
            host,
          }),
        ],
      }),
    ]);
    for (const m of [...client.errors, ...fns.errors]) errors.push(fromEsbuild(m));
    const tw = tailwind ? await tailwind : null;
    if (tw && !tw.ok) {
      errors.push(
        fail("Стили дизайн-системы не собираются (ui/design.css)", {
          file: DESIGN_CSS_PATH,
          evidence: clip(tw.error, 500),
          fixHint:
            "В ui/design.css допустимы только CSS-переменные, @theme и правила без @import, @plugin и @config",
        }),
      );
    }
    if (errors.length > 0) return failed();
    const twCss = tw?.ok
      ? (
          await esbuild.transform(tw.css, {
            loader: "css",
            minifyWhitespace: true,
            charset: "utf8",
            legalComments: "inline",
          })
        ).code
      : null;

    const outDir = join(copyDir, "out");
    const hostPrefix = hostPathPrefix(copyDir, [
      ...Object.values(host),
      ...(v3Host ? [v3Host.react, v3Host.motionReact] : []),
    ]);
    const clientFiles = new Map<string, Uint8Array>();
    let script = "";
    let style: string | null = null;
    for (const f of [...client.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const rel = toPosix(relative(outDir, f.path));
      const m = /^assets\/index\.(js|css)$/.exec(rel);
      if (!m) {
        clientFiles.set(rel, f.contents);
        continue;
      }
      // Module keys of CJS wrappers carry paths relative to the copy dir: strip the host part, then
      // name the file by its own content hash so the output does not depend on where the repo lives.
      let text = hostPrefix ? f.text.replaceAll(hostPrefix, "") : f.text;
      if (m[1] === "css" && twCss !== null) text = layeredCss(twCss, text);
      const name = `assets/index-${sha256Hex(text).slice(0, 12)}.${m[1]}`;
      clientFiles.set(name, new TextEncoder().encode(text));
      if (m[1] === "js") script = name;
      else style = name;
    }
    if (twCss !== null && style === null) {
      const text = layeredCss(twCss, null);
      style = `assets/index-${sha256Hex(text).slice(0, 12)}.css`;
      clientFiles.set(style, new TextEncoder().encode(text));
    }
    clientFiles.set(
      "index.html",
      new TextEncoder().encode(indexHtml(spec, env, script, style, input.platformOrigin, seo)),
    );
    const serverFunctions = fns.files[0]?.text ?? "";

    const clientSize = [...clientFiles.values()].reduce((n, b) => n + b.byteLength, 0);
    const fnSize = Buffer.byteLength(serverFunctions);
    if (clientSize > UI_BUNDLE_LIMIT) {
      errors.push(fail(`Интерфейс системы слишком большой: ${clientSize} байт (предел 2 МБ)`));
    }
    if (clientSize + fnSize > SYSTEM_BUNDLE_LIMIT) {
      errors.push(fail(`Бандл системы слишком большой: ${clientSize + fnSize} байт (предел 5 МБ)`));
    }
    if (errors.length > 0) return failed();

    const clientHashes: Record<string, string> = {};
    for (const p of [...clientFiles.keys()].sort())
      clientHashes[p] = sha256Hex(clientFiles.get(p) as Uint8Array);
    const wz = env === "draft" ? wzMap : null;
    const fnHash = sha256Hex(serverFunctions);
    const manifest: BuildManifest = {
      ...emptyManifest(spec, env),
      contentHash: sha256Hex(canonicalJson({ client: clientHashes, functions: fnHash, wzMap: wz })),
      entry: { script, style },
      client: clientHashes,
      functions: {
        file: "server/functions.mjs",
        sha256: fnHash,
        names: (spec.functions ?? []).map((f) => f.name).sort(),
      },
      wzMap: wz !== null,
      sizes: { client: clientSize, functions: fnSize },
    };
    return { ok: true, errors: [], client: clientFiles, serverFunctions, wzMap: wz, manifest, spec };
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
}
