// Deterministic TSX emitters shared by the module screens and the D75 template (packages/agents builder/template.ts):
// values go through JSON.stringify, so texts from a plan can never break out of an attribute.

/** JSON literal of a value for a TSX expression. */
export const js = (v: unknown): string => JSON.stringify(v);

/** PascalCase of an identifier or file part: lead_form → LeadForm. */
export const pascal = (s: string): string =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join("");

/**
 * A TSX attribute: `[name, value]` — `name={json}`; `[name, value, "lit"]` — `name="value"` (only for ident-like
 * constants such as variants and anchors); `[name, code, "expr"]` — `name={code}` for an expression the generator
 * assembled from js() literals (never from plan text as is); `[name, true]` — a bare boolean attribute;
 * undefined/false — omitted.
 */
export type JsxAttr = readonly [name: string, value: unknown, kind?: "lit" | "expr"];

/** One self-closing ui-kit element: `<Name a={…} b="…" c />`. */
export function jsxEl(name: string, attrs: readonly JsxAttr[]): string {
  const parts: string[] = [];
  for (const [k, v, kind] of attrs) {
    if (v === undefined || v === false || v === null) continue;
    if (v === true) parts.push(k);
    else if (kind === "lit") parts.push(`${k}="${String(v).replace(/[^A-Za-z0-9_-]/g, "")}"`);
    else if (kind === "expr") parts.push(`${k}={${String(v)}}`);
    else parts.push(`${k}={${js(v)}}`);
  }
  return `<${name}${parts.length ? ` ${parts.join(" ")}` : ""} />`;
}

/**
 * A page module: header comment, ui-kit imports (sorted) and a default-exported fragment of blocks. `local` maps
 * components of other generated files to their relative module (e.g. ServiceShowcase → ./CatalogServices).
 */
export function fragmentPage(
  comment: string,
  imports: Iterable<string>,
  blocks: readonly string[],
  local: Readonly<Record<string, string>> = {},
  /** Lines at the top of the component (hooks), indented by the caller. */
  hooks: readonly string[] = [],
): string {
  const names = [...new Set(imports)].sort();
  const fromKit = names.filter((n) => local[n] === undefined);
  const fromLocal = new Map<string, string[]>();
  for (const n of names) {
    const from = local[n];
    if (from !== undefined) fromLocal.set(from, [...(fromLocal.get(from) ?? []), n]);
  }
  return [
    comment,
    'import { useEffect } from "@wizard/sdk";',
    ...(fromKit.length ? [`import { ${fromKit.join(", ")} } from "@wizard/ui-kit";`] : []),
    ...[...fromLocal].map(([from, ns]) => `import { ${ns.join(", ")} } from ${js(from)};`),
    "",
    "export default function Home() {",
    ...hooks,
    // A link from another page («Выбрать» on /services → /#lead) loads before the sections render, so the browser
    // finds no anchor to scroll to: scroll once they are on the page.
    // Sections that load their data (catalog, prices) grow above the anchor after mount, so keep it in view while
    // the page settles — until the visitor scrolls or presses a key, at most 2 s.
    "  useEffect(() => {",
    "    const id = decodeURIComponent(location.hash.slice(1));",
    "    const el = id ? document.getElementById(id) : null;",
    "    if (!el) return;",
    "    el.scrollIntoView();",
    "    const ro = new ResizeObserver(() => el.scrollIntoView());",
    "    ro.observe(document.body);",
    "    const stop = () => ro.disconnect();",
    "    const timer = setTimeout(stop, 2000);",
    '    for (const e of ["wheel", "touchstart", "keydown"]) addEventListener(e, stop, { once: true });',
    "    return () => {",
    "      clearTimeout(timer);",
    "      stop();",
    "    };",
    "  }, []);",
    "  return (",
    "    <>",
    ...blocks.map((b) => `      ${b}`),
    "    </>",
    "  );",
    "}",
    "",
  ].join("\n");
}
