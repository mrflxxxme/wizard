// Live first screens of «Три направления» (V3-09): each direction is a one-page v3 system built by buildSystem, in
// parallel, and kept in memory (rebuilt from the stored proposal after a restart). The platform shows it in
// <iframe srcdoc sandbox="allow-scripts">: an opaque origin under the platform's own CSP, so the page's files are
// served from /api/v1/direction-previews/* (same origin, 'self') with CORS for the null origin, and a classic boot
// script answers the bundle's /_wizard/spec read with the preview's RoleSpec.
import { createHash } from "node:crypto";
import {
  type DirectionsProposal,
  directionDesign,
  directionPreview,
  type PreviewPaths,
  type StoredDirection,
} from "@wizard/agents/builder";
import { buildSystem } from "@wizard/build";
import { buildRoleSpec } from "@wizard/runtime";

/** Public prefix of the preview files (api.yaml: /direction-previews/*), as the platform page sees it. */
export const PREVIEW_PREFIX = "/api/v1/direction-previews";
export const PREVIEW_PATHS: PreviewPaths = {
  fontBase: `${PREVIEW_PREFIX}/fonts/`,
  photoBase: `${PREVIEW_PREFIX}/photos/`,
};
/** Built previews kept in memory (three per proposal; refinements reuse unchanged directions by content). */
export const PREVIEW_CACHE_SIZE = 90;

export interface PreviewFile {
  body: Uint8Array;
  type: string;
}

export interface BuiltPreview {
  /** File path → content (assets/*.js, assets/*.css, boot.js). */
  files: Map<string, PreviewFile>;
  script: string;
  style: string | null;
  /** Wall time of the build, ms. */
  ms: number;
}

const TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const typeOf = (path: string) => TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";

/**
 * Classic script that runs before the module bundle: /_wizard/spec from the preview itself (no runtime behind it), and
 * WzProvider's v2 token <style> left unattached — v3 pages read ui/design.css only, and the platform CSP the srcdoc
 * frame inherits refuses inline styles.
 */
export function bootScript(roleSpec: unknown): string {
  return [
    "(function () {",
    `  var spec = ${JSON.stringify(JSON.stringify(roleSpec))};`,
    "  var nativeFetch = window.fetch.bind(window);",
    "  window.fetch = function (input, init) {",
    '    var url = typeof input === "string" ? input : input && input.url;',
    '    if (url === "/_wizard/spec")',
    '      return Promise.resolve(new Response(spec, { status: 200, headers: { "content-type": "application/json" } }));',
    "    return nativeFetch(input, init);",
    "  };",
    "  var append = Node.prototype.appendChild;",
    "  Node.prototype.appendChild = function (node) {",
    '    if (node && node.nodeName === "STYLE" && node.hasAttribute("data-wz-tokens-for")) return node;',
    "    return append.call(this, node);",
    "  };",
    "})();",
    "",
  ].join("\n");
}

/** The RoleSpec of the preview's public role, as the runtime's /_wizard/spec would answer (no consent text, prod). */
export const previewRoleSpec = (spec: Parameters<typeof buildRoleSpec>[0]) =>
  buildRoleSpec(spec, {
    role: "visitor",
    compliance: { consentText: null, policyPage: null, policyVersion: "", consentTextHash: "" },
    features: { phoneOtp: false },
    env: "prod",
  });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The srcdoc document of a built preview: its stylesheet, the boot script and the module bundle. */
export function previewHtml(proposalId: string, n: number, title: string, b: BuiltPreview): string {
  const base = `${PREVIEW_PREFIX}/${proposalId}/${n}`;
  return [
    "<!doctype html>",
    '<html lang="ru">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    ...(b.style ? [`<link rel="stylesheet" href="${base}/${b.style}">`] : []),
    `<script src="${base}/boot.js"></script>`,
    `<script type="module" src="${base}/${b.script}"></script>`,
    "</head>",
    '<body><div id="root"></div></body>',
    "</html>",
    "",
  ].join("\n");
}

export class PreviewBuildError extends Error {
  constructor(readonly evidence: string) {
    super(`preview build failed: ${evidence}`);
    this.name = "PreviewBuildError";
  }
}

/** Builds of the direction previews with an LRU in memory, keyed by the content of the build input. */
export class PreviewBuilds {
  readonly #cache = new Map<string, Promise<BuiltPreview>>();
  readonly #byDirection = new Map<string, string>();
  constructor(readonly size = PREVIEW_CACHE_SIZE) {}

  /** The build of direction `d` of proposal `id` (built once per distinct input). */
  build(id: string, p: DirectionsProposal, d: StoredDirection): Promise<BuiltPreview> {
    const design = directionDesign(p, d).design;
    const system = directionPreview(
      { n: d.n, header: d.header, hero: d.hero, design },
      { name: p.name, nav: p.nav, texts: d.texts, photos: d.tuning.photos !== false },
      PREVIEW_PATHS,
    );
    const key = createHash("sha256")
      .update(JSON.stringify([system.spec, [...system.files]]))
      .digest("hex");
    this.#byDirection.delete(`${id}:${d.n}`);
    this.#byDirection.set(`${id}:${d.n}`, key);
    // The index of proposal directions stays as small as the builds it points to (oldest first out).
    while (this.#byDirection.size > this.size * 3)
      this.#byDirection.delete(this.#byDirection.keys().next().value as string);
    const hit = this.#cache.get(key);
    if (hit) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return hit;
    }
    const job = (async (): Promise<BuiltPreview> => {
      const started = Date.now();
      const r = await buildSystem({ spec: system.spec, files: system.files, env: "prod" });
      if (!r.ok) throw new PreviewBuildError(JSON.stringify(r.errors.map((e) => e.message_ru)).slice(0, 500));
      const files = new Map<string, PreviewFile>();
      for (const [path, body] of r.client)
        if (path !== "index.html") files.set(path, { body, type: typeOf(path) });
      files.set("boot.js", {
        body: new TextEncoder().encode(bootScript(previewRoleSpec(system.spec))),
        type: TYPES.js as string,
      });
      return {
        files,
        script: r.manifest.entry.script,
        style: r.manifest.entry.style,
        ms: Date.now() - started,
      };
    })();
    // A failed build is not cached: the next request tries again.
    job.catch(() => this.#cache.delete(key));
    this.#cache.set(key, job);
    while (this.#cache.size > this.size) {
      const oldest = this.#cache.keys().next().value as string;
      this.#cache.delete(oldest);
    }
    return job;
  }

  /** A build already made for this proposal's direction, if still in memory. */
  cached(id: string, n: number): Promise<BuiltPreview> | undefined {
    const key = this.#byDirection.get(`${id}:${n}`);
    return key ? this.#cache.get(key) : undefined;
  }
}
