// A v3 preview system for the pattern matrix: ui/design.css of a fixture, every pattern as ui/patterns/<id>.tsx and
// one page rendering each with its example content — built by buildSystem like any system and served with the
// runtime's endpoints the bundle needs (/_wizard/spec, /_wizard/fonts, /_wizard/photos) and, for the module-bound
// patterns (needs: lead, booking, catalog, content), a stand-in of the data API their headless hooks call through the
// SDK DataSource of the template's WzProvider (patterns-v3-data.ts).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { toRoleSpec } from "@wizard/ui-kit";
import type { PatternMeta } from "@wizard/ui-kit/v3/patterns";
import type { BuildResult } from "../src/index.js";
import { type DesignCss, type DesignFixture, designCss } from "./fixtures-v3.js";
import { loadForum, REPO_ROOT } from "./helpers.js";
import { type PreviewMode, type PreviewWrite, previewApi, withPreviewData } from "./patterns-v3-data.js";

export const PREVIEW_PAGE = "ui/pages/Preview.tsx";
const FONTS = join(REPO_ROOT, "packages/ui-kit/fonts");

function pascal(id: string): string {
  return id.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase());
}

/** A section of the preview page: the TSX of ui/patterns/<id>.tsx and the props it gets. */
export interface PreviewItem {
  id: string;
  source: string;
  props: unknown;
}

/** Library patterns with their example content (validated by the slot schema). */
export function previewItems(patterns: readonly PatternMeta[]): PreviewItem[] {
  return patterns.map((p) => ({ id: p.id, source: p.source, props: p.slots.parse(p.example) }));
}

/**
 * The wrapper of a section: [data-preview="<id>"] appears once nothing inside is aria-busy (the data of a module-bound
 * pattern has loaded), so the checks and screenshots see the section with its data, not its loading state. A layout
 * effect: a section without data is marked in the commit that first renders it (before any observer of the page runs).
 */
const READY_TSX = `function Ready({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new MutationObserver(() => check());
    const check = () => {
      if (el.querySelector("[aria-busy=true]")) return;
      obs.disconnect();
      setReady(true);
    };
    obs.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-busy"] });
    check();
    return () => obs.disconnect();
  }, []);
  const attr = ready ? { "data-preview": id } : { "data-preview-wait": id };
  return (
    <div ref={ref} {...attr}>
      {children}
    </div>
  );
}`;

/** Spec and files of a preview system with the given sections rendered in order, each in [data-preview="<id>"]. */
export function previewSystem(fixture: DesignFixture | DesignCss, patterns: readonly PreviewItem[]) {
  const forum = withPreviewData(loadForum());
  const role = forum.roles.find((r) => r.access === "public")?.name ?? "visitor";
  const spec: AppSpec = {
    ...forum,
    functions: [],
    pages: [{ route: "/", title: "Паттерны", file: PREVIEW_PAGE, roles: [role] }],
  };
  const files = new Map<string, string>([
    ["ui/design.css", "css" in fixture ? fixture.css : designCss(fixture)],
  ]);
  for (const p of patterns) files.set(`ui/patterns/${p.id}.tsx`, p.source);
  const page = [
    'import { type ReactNode, useLayoutEffect, useRef, useState } from "react";',
    ...patterns.map((p) => `import ${pascal(p.id)} from "../patterns/${p.id}";`),
    "",
    READY_TSX,
    "",
    "export default function Preview() {",
    "  return (",
    '    <main className="bg-background">',
    ...patterns.map(
      (p) =>
        `      <Ready id="${p.id}">\n        <${pascal(p.id)} {...${JSON.stringify(p.props)}} />\n      </Ready>`,
    ),
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n");
  files.set(PREVIEW_PAGE, page);
  return { spec, files };
}

/** A photo-like SVG (two-tone gradient with a shape) for /_wizard/photos/<name> and the image fields of the data. */
function photo(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 35% 78%)"/>` +
    `<stop offset="1" stop-color="hsl(${(h + 40) % 360} 30% 32%)"/></linearGradient></defs>` +
    `<rect width="1600" height="1200" fill="url(#g)"/><circle cx="1050" cy="520" r="300" fill="hsl(${h} 20% 90%)"/></svg>`
  );
}

export interface PreviewServer {
  url: string;
  /** Writes the page sent to the data API and the functions (bodies with _consent), in order. */
  writes: readonly PreviewWrite[];
  /** How the data API answers from now on (default ok). */
  setMode(mode: PreviewMode): void;
  close(): Promise<void>;
}

/** Serves the built client files of a system at `/` plus the runtime endpoints the bundle calls. */
export async function servePreview(spec: AppSpec, build: BuildResult): Promise<PreviewServer> {
  // policyVersion and the text hash: the SDK sends them as _consent with a write that needs consent (G2-PII-04).
  const roleSpec = JSON.stringify(toRoleSpec(spec, null, { policyVersion: "1", consentTextHash: "preview" }));
  const api = previewApi(photo);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://preview.local");
    const send = (status: number, type: string, body: string | Uint8Array) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (url.pathname.startsWith("/api/")) {
      void api.handle(req, res, url).then((done) => {
        if (!done) send(404, "application/json", '{"error":{"code":"NOT_FOUND","message":"Не найдено"}}');
      });
      return;
    }
    const path = decodeURIComponent(url.pathname);
    if (path === "/_wizard/spec") return send(200, "application/json", roleSpec);
    const font = /^\/_wizard\/fonts\/([\w.-]+\.woff2)$/.exec(path);
    if (font) {
      try {
        return send(200, "font/woff2", readFileSync(join(FONTS, font[1] as string)));
      } catch {
        return send(404, "text/plain", "");
      }
    }
    const pic = /^\/_wizard\/photos\/([\w.-]+)$/.exec(path);
    if (pic) return send(200, "image/svg+xml", photo(pic[1] as string));
    const file = build.client.get(path === "/" ? "index.html" : path.slice(1));
    if (file) {
      const type = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".woff2")
            ? "font/woff2"
            : "text/html; charset=utf-8";
      return send(200, type, file);
    }
    // History routes fall back to the page (the SPA routes on the client).
    return send(200, "text/html; charset=utf-8", build.client.get("index.html") ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    writes: api.writes,
    setMode: api.setMode,
    close: () => {
      // The SSE streams of the pages stay open: end them, or close() waits for them.
      api.close();
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
