// Tailwind CSS v4 for public pages of v3 systems (specs/agents/builder-v3.md §1): the JS API of `tailwindcss`
// (compile → build(candidates)) without the native oxide scanner. Candidates come from our own tokenizer of string
// literals in ui/pages/**, ui/patterns/** and ui/sections/**; the theme is the client's design system ui/design.css.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { compile } from "tailwindcss";
import ts from "typescript";

/** The design system file of a v3 system (C2 designSystemCss): its presence switches Tailwind on. */
export const DESIGN_CSS_PATH = "ui/design.css";
/** Sources scanned for class candidates. */
export const TAILWIND_SOURCE_RE = /^ui\/(?:pages|patterns|sections)\/.+\.tsx?$/;
/** Cascade layer of the ui-kit CSS in a v3 bundle: above Tailwind's preflight, below its components and utilities. */
export const KIT_LAYER = "wizard";
const LAYER_ORDER = `@layer theme, base, ${KIT_LAYER}, components, utilities;`;
const MAX_CANDIDATE = 160;
// A token can be a utility: ASCII without quotes, braces or angle brackets, with a letter, not a path or a URL.
const CANDIDATE_RE = /^[\w\-:/.%[\]()#!@*&>+~=',]+$/;
const HAS_LETTER_RE = /[a-z]/i;

const req = createRequire(import.meta.url);

/** True for a v3 system: it carries the design system file ui/design.css. */
export function isTailwindSystem(files: ReadonlyMap<string, string>): boolean {
  return files.has(DESIGN_CSS_PATH);
}

function collectStrings(path: string, text: string, out: string[]): void {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push(n.text);
    }
    // Module specifiers are not classes.
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    n.forEachChild(visit);
  };
  visit(sf);
}

/**
 * Class candidates of the sources (path → text): every whitespace-separated token of every string literal and
 * template chunk that may be a utility. Tailwind ignores the tokens that are not, so over-collection is harmless;
 * classes assembled from pieces at run time ("bg-" + tone) are not found, as with Tailwind's own scanner.
 */
export function tailwindCandidates(sources: Iterable<readonly [string, string]>): string[] {
  const strings: string[] = [];
  for (const [path, text] of sources) if (TAILWIND_SOURCE_RE.test(path)) collectStrings(path, text, strings);
  const out = new Set<string>();
  for (const s of strings)
    for (const tok of s.split(/\s+/))
      if (
        tok.length <= MAX_CANDIDATE &&
        CANDIDATE_RE.test(tok) &&
        HAS_LETTER_RE.test(tok) &&
        !tok.startsWith("/") &&
        !tok.includes("//")
      )
        out.add(tok);
  return [...out].sort();
}

function tailwindIndexCss(): { path: string; base: string; content: string } {
  const path = req.resolve("tailwindcss/index.css");
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

export type TailwindResult = { ok: true; css: string } | { ok: false; error: string };

/**
 * `@import "tailwindcss"` + the design system CSS, built for the candidates. The design system may not import other
 * stylesheets or load plugins and configs: it is code of the system, built on the host.
 */
export async function compileTailwind(
  designCss: string,
  candidates: readonly string[],
): Promise<TailwindResult> {
  let imported = false;
  try {
    const compiler = await compile(`@import "tailwindcss";\n${designCss}`, {
      base: "/",
      loadStylesheet: async (id) => {
        if (id !== "tailwindcss" || imported) throw new Error(`@import «${id}» не допускается`);
        imported = true;
        return tailwindIndexCss();
      },
      loadModule: async (id) => {
        throw new Error(`@plugin и @config («${id}») не допускаются`);
      },
    });
    const css = compiler.build([...candidates]);
    // Tailwind keeps @import of a URL as is: no stylesheets from other hosts (CSP of systems, 152-ФЗ).
    const external = /@import\s+(?:url\()?\s*["']?([^"');\s]+)/.exec(css);
    if (external) return { ok: false, error: `@import «${external[1]}» не допускается` };
    return { ok: true, css };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Tailwind CSS of a v3 system (null for a system without ui/design.css). */
export async function systemTailwind(files: ReadonlyMap<string, string>): Promise<TailwindResult | null> {
  const design = files.get(DESIGN_CSS_PATH);
  if (design === undefined) return null;
  let candidates: string[];
  try {
    candidates = tailwindCandidates(files);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return compileTailwind(design, candidates);
}

/**
 * The CSS of a v3 bundle: the layer order first, Tailwind (theme, preflight, utilities), then the ui-kit CSS inside
 * its own layer, so the kit's document rules (a, :focus-visible, html) yield to utilities and still win over preflight.
 */
export function layeredCss(tailwind: string, kit: string | null): string {
  return kit
    ? `${LAYER_ORDER}\n${tailwind}\n@layer ${KIT_LAYER} {\n${kit}\n}\n`
    : `${LAYER_ORDER}\n${tailwind}`;
}
