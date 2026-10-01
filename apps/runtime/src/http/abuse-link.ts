// «Пожаловаться» on every prod page of a system (security/abuse.yaml#report.entry_points, M2-08): the runtime inserts the
// link into the document it serves (the bundle's index.html), outside the app's root, so system code does not render it
// and cannot leave it out. It leads to the public complaint form of the platform with the page URL prefilled.
import { escapeHtml } from "../preview/headers.js";
import type { RuntimeContext } from "./context.js";

export const ABUSE_LINK_TEST_ID = "wz-abuse-link";

/** Complaint form URL on the platform for a page of a system. */
export function abuseFormUrl(platformOrigin: string, pageUrl: string): string {
  return `${platformOrigin.replace(/\/+$/, "")}/abuse?url=${encodeURIComponent(pageUrl)}`;
}

/** Inserts the link before </body> (once). Inline style only: the document CSP allows inline styles, not scripts. */
export function injectAbuseLink(html: string, o: { platformOrigin: string; pageUrl: string }): string {
  if (html.includes(`data-testid="${ABUSE_LINK_TEST_ID}"`)) return html;
  const style = [
    "position:fixed",
    "right:8px",
    "bottom:8px",
    "z-index:2147483647",
    "font:12px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
    "color:#4a4a4a",
    "background:rgba(255,255,255,.92)",
    "border:1px solid rgba(0,0,0,.12)",
    "border-radius:6px",
    "padding:2px 8px",
    "text-decoration:underline",
  ].join(";");
  const link = `<a href="${escapeHtml(abuseFormUrl(o.platformOrigin, o.pageUrl))}" data-testid="${ABUSE_LINK_TEST_ID}" rel="noopener" style="${style}">Пожаловаться</a>`;
  const at = html.lastIndexOf("</body>");
  return at < 0 ? `${html}${link}` : `${html.slice(0, at)}${link}\n${html.slice(at)}`;
}

/** URL of the requested page as the visitor sees it (Host header; scheme from WIZARD_PUBLIC_SCHEME). */
export function publicPageUrl(
  scheme: "http" | "https",
  host: string | undefined,
  requestUrl: string,
): string {
  const u = new URL(requestUrl);
  return `${scheme}://${host ?? u.host}${u.pathname}`;
}

/** Prod documents carry «Пожаловаться» (security/abuse.yaml#report.entry_points); drafts are closed previews. */
export function withAbuseLink(c: RuntimeContext, html: string): string {
  const sys = c.get("system");
  if (sys.entry.env !== "prod") return html;
  const env = c.get("services").env;
  return injectAbuseLink(html, {
    platformOrigin: env.platformOrigin,
    pageUrl: publicPageUrl(env.publicScheme, c.req.header("host"), c.req.url),
  });
}
