// Headers of documents and static files of a system host (runtime.yaml#security_headers, #static).
// frame-ancestors is appended by http/guards.ts#securityHeaders for every response.

/** runtime.yaml#security_headers.csp without frame-ancestors; no third-party origins. */
export const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export const NO_CACHE = "no-cache";
export const IMMUTABLE = "public, max-age=31536000, immutable";

/** Headers of an HTML document of a system (bundle index.html, runtime templates). */
export function documentHeaders(cacheControl = NO_CACHE): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": cacheControl,
    "Content-Security-Policy": DOCUMENT_CSP,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), geolocation=()",
  };
}

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

export function contentType(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Minimal Russian HTML document for runtime templates (login, policy, pay-mock). */
export function htmlPage(title: string, body: string, scripts: readonly string[] = []): string {
  return [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    ...scripts.map((s) => `<script src="${escapeHtml(s)}" defer></script>`),
    `</head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
  ].join("");
}
