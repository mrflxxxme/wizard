// PWA of every system (runtime.yaml#static.pwa, M2-03): /manifest.webmanifest from app.name and theme, /sw.js with
// the shell of the current revision, /_wizard/pwa.js (registration) and a monogram icon; index.html gets the links.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { escapeHtml } from "../preview/headers.js";
import type { LoadedSystem } from "../system.js";

const SW_SOURCE = readFileSync(new URL("./sw-client.js", import.meta.url), "utf8");
export const REGISTER_SCRIPT = readFileSync(new URL("./register-client.js", import.meta.url), "utf8");
const SW_SOURCE_HASH = createHash("sha256").update(SW_SOURCE).digest("hex").slice(0, 8);

/** ui-kit tokens default (packages/ui-kit/src/tokens/tokens.ts). */
const DEFAULT_ACCENT = "#2F46D8";
export const ICON_PATH = "/_wizard/icon.svg";
export const REGISTER_PATH = "/_wizard/pwa.js";
const ASSET_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;

const accentOf = (spec: AppSpec) => spec.theme?.accent ?? DEFAULT_ACCENT;

/** First letter of the app name for the monogram icon. */
function initial(name: string): string {
  const m = /\p{L}|\p{N}/u.exec(name);
  return (m?.[0] ?? "W").toLocaleUpperCase("ru");
}

function shortName(name: string): string {
  if (name.length <= 15) return name;
  const words = name.split(/\s+/);
  let out = "";
  for (const w of words) {
    if (`${out} ${w}`.trim().length > 15) break;
    out = `${out} ${w}`.trim();
  }
  return out || name.slice(0, 15);
}

/** Width/height from the IHDR chunk of a PNG; null for anything else. */
function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR")
    return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function monogramSvg(spec: AppSpec): string {
  const accent = accentOf(spec);
  const ink = /^#([0-9a-f]{6})$/i.test(accent) && luminance(accent) > 0.45 ? "#111318" : "#FFFFFF";
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">',
    `<rect width="512" height="512" rx="96" fill="${accent}"/>`,
    `<text x="256" y="256" dy=".35em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" font-size="300" font-weight="700" fill="${ink}">${escapeHtml(initial(spec.app.name))}</text>`,
    "</svg>",
  ].join("");
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}

export async function webManifest(sys: LoadedSystem): Promise<Record<string, unknown>> {
  const { spec } = sys;
  const icons: Record<string, string>[] = [
    { src: ICON_PATH, sizes: "any", type: "image/svg+xml", purpose: "any" },
  ];
  const logo = spec.theme?.logoFile;
  if (logo && sys.artifactDir && ASSET_RE.test(logo) && logo.endsWith(".png")) {
    const buf = await readFile(join(sys.artifactDir, "client", "assets", logo)).catch(() => null);
    const size = buf ? pngSize(buf) : null;
    if (size && size.w === size.h && size.w >= 144) {
      icons.unshift({
        src: `/assets/${logo}`,
        sizes: `${size.w}x${size.h}`,
        type: "image/png",
        purpose: "any",
      });
    }
  }
  return {
    id: "/",
    name: spec.app.name,
    short_name: shortName(spec.app.name),
    ...(spec.app.description ? { description: spec.app.description } : {}),
    lang: "ru",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: accentOf(spec),
    icons,
  };
}

/** Body of /sw.js: config line + the worker; the version changes with the bundle and the worker source. */
export async function serviceWorker(sys: LoadedSystem): Promise<string> {
  let assets: string[] = [];
  if (sys.artifactDir) {
    assets = (await readdir(join(sys.artifactDir, "client", "assets")).catch(() => [] as string[]))
      .filter((n) => ASSET_RE.test(n))
      .sort()
      .map((n) => `/assets/${n}`);
  }
  const version = createHash("sha256")
    .update(
      `${sys.entry.systemId}|${sys.entry.env}|${sys.entry.revision}|${sys.entry.bundleKey}|${SW_SOURCE_HASH}`,
    )
    .digest("hex")
    .slice(0, 16);
  const precache = ["/", "/manifest.webmanifest", ICON_PATH, REGISTER_PATH, ...assets];
  return `self.__WZ_SW = ${JSON.stringify({ version, precache })};\n${SW_SOURCE}`;
}

/** Links of the PWA in <head> of the bundle's index.html (artifacts built before M2-03 get them too). */
export function injectPwa(html: string, spec: AppSpec): string {
  if (html.includes('rel="manifest"')) return html;
  const tags = [
    '<link rel="manifest" href="/manifest.webmanifest">',
    `<meta name="theme-color" content="${escapeHtml(accentOf(spec))}">`,
    `<link rel="icon" href="${ICON_PATH}" type="image/svg+xml">`,
    `<script src="${REGISTER_PATH}" defer></script>`,
  ].join("\n");
  const at = html.indexOf("</head>");
  return at < 0 ? html : `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
}
