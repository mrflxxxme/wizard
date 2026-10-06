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
 * constants such as variants and anchors); `[name, true]` — a bare boolean attribute; undefined/false — omitted.
 */
export type JsxAttr = readonly [name: string, value: unknown, kind?: "lit"];

/** One self-closing ui-kit element: `<Name a={…} b="…" c />`. */
export function jsxEl(name: string, attrs: readonly JsxAttr[]): string {
  const parts: string[] = [];
  for (const [k, v, kind] of attrs) {
    if (v === undefined || v === false || v === null) continue;
    if (v === true) parts.push(k);
    else if (kind === "lit") parts.push(`${k}="${String(v).replace(/[^A-Za-z0-9_-]/g, "")}"`);
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
): string {
  const names = [...new Set(imports)].sort();
  const fromKit = names.filter((n) => local[n] === undefined);
  const fromLocal = names.filter((n) => local[n] !== undefined);
  return [
    comment,
    ...(fromKit.length ? [`import { ${fromKit.join(", ")} } from "@wizard/ui-kit";`] : []),
    ...fromLocal.map((n) => `import { ${n} } from ${js(local[n])};`),
    "",
    "export default function Home() {",
    "  return (",
    "    <>",
    ...blocks.map((b) => `      ${b}`),
    "    </>",
    "  );",
    "}",
    "",
  ].join("\n");
}
