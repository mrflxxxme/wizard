// Minimal parser for react-dom/server output (well-formed, no scripts) and the G1-RENDER-01 page checks:
// blank page, wz-id coverage (ui-kit.yaml#wz_id), consent on forms writing pii fields (compliance.yaml#…consent).
import type { WzMap } from "@wizard/build";

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  text: string;
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const TOKEN_RE =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s/>=]+(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s/>=]+)(?:="([^"]*)")?/g;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#x27": "'",
  "#39": "'",
  nbsp: " ",
};
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k] as string;
    if (k.startsWith("#x")) return String.fromCodePoint(Number.parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number.parseInt(k.slice(1), 10));
    return m;
  });

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: HtmlNode[] = [root];
  let last = 0;
  const top = () => stack[stack.length - 1] as HtmlNode;
  for (const m of html.matchAll(TOKEN_RE)) {
    const text = html.slice(last, m.index);
    if (text) top().children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(text) });
    last = (m.index ?? 0) + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const tag = (m[2] as string).toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(ATTR_RE))
      attrs[(a[1] as string).toLowerCase()] = decodeEntities(a[2] ?? "");
    const node: HtmlNode = { tag, attrs, children: [], text: "" };
    top().children.push(node);
    if (!VOID.has(tag) && m[4] !== "/") stack.push(node);
  }
  const tail = html.slice(last);
  if (tail) top().children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(tail) });
  return root;
}

export function walk(
  n: HtmlNode,
  fn: (n: HtmlNode, ancestors: HtmlNode[]) => void,
  anc: HtmlNode[] = [],
): void {
  fn(n, anc);
  for (const c of n.children) walk(c, fn, [...anc, n]);
}

export function textOf(n: HtmlNode): string {
  if (n.tag === "#text") return n.text;
  return n.children.map(textOf).join(" ");
}

const CONTENT_TAGS = new Set([
  "img",
  "input",
  "button",
  "select",
  "textarea",
  "svg",
  "canvas",
  "video",
  "iframe",
]);

/** Nothing a user could see or use: no text and no media/control elements. */
export function isBlank(root: HtmlNode): boolean {
  let content = textOf(root).replace(/\s+/g, "").length > 0;
  if (!content)
    walk(root, (n) => {
      if (CONTENT_TAGS.has(n.tag)) content = true;
    });
  return !content;
}

export interface WzProblem {
  component: string;
  wzId: string | null;
}

/** Every [data-wz-component] carries a data-wz-id the build injected (not the demo fallback, ui-kit.yaml#wz_id). */
export function wzProblems(root: HtmlNode, map: WzMap): WzProblem[] {
  const out: WzProblem[] = [];
  walk(root, (n) => {
    const component = n.attrs["data-wz-component"];
    if (component === undefined) return;
    const id = n.attrs["data-wz-id"] ?? null;
    if (!id || !map[id]) out.push({ component, wzId: id });
  });
  return out;
}

const FIELD_TESTID = /^wz-field-([a-z][a-z0-9_]*)(?:--.*)?$/;

/** Field names a <form> submits: ui-kit fields (data-testid wz-field-<name>) and native name= controls. */
function formFields(form: HtmlNode): Set<string> {
  const out = new Set<string>();
  walk(form, (n) => {
    const m = FIELD_TESTID.exec(n.attrs["data-testid"] ?? "");
    if (m) out.add(m[1] as string);
    if ((n.tag === "input" || n.tag === "select" || n.tag === "textarea") && n.attrs.name)
      out.add(n.attrs.name);
  });
  return out;
}

/**
 * Forms (outside the platform login, wz-login) that write a pii≠none field the role may create/update, without a
 * consent checkbox (data-testid wz-consent…) inside. Returns the pii field names of each such form.
 */
export function formsWithoutConsent(root: HtmlNode, writablePii: ReadonlySet<string>): string[][] {
  const out: string[][] = [];
  walk(root, (n, anc) => {
    if (n.tag !== "form") return;
    if ([n, ...anc].some((a) => a.attrs["data-testid"] === "wz-login")) return;
    const pii = [...formFields(n)].filter((f) => writablePii.has(f));
    if (pii.length === 0) return;
    let consent = false;
    walk(n, (c) => {
      if ((c.attrs["data-testid"] ?? "").startsWith("wz-consent")) consent = true;
    });
    if (!consent) out.push(pii);
  });
  return out;
}
