// V3-08 (node): Tailwind v4 in @wizard/build — the candidate tokenizer, compile over the design system with imports,
// plugins and foreign stylesheets refused, the v3 bundle (Tailwind CSS + ui-kit CSS in layer «wizard», React and
// Motion importable, Motion in the bundle) and v2 builds untouched; every class of every pattern compiles on every
// fixture design system and uses only theme keys of the C2/C3 contract.
import { PATTERN_THEME, PATTERNS, patternThemeVars } from "@wizard/ui-kit/v3/patterns";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  buildSystem,
  compileTailwind,
  DESIGN_CSS_PATH,
  isTailwindSystem,
  layeredCss,
  tailwindCandidates,
} from "../src/index.js";
import type { BuildResult } from "../src/types.js";
import { DESIGN_FIXTURES, designCss, fixtureContrasts } from "./fixtures-v3.js";
import { build, clientText, forumFiles, loadForum } from "./helpers.js";
import { previewItems, previewSystem } from "./v3-harness.js";

const css = (r: BuildResult) => {
  const style = r.manifest.entry.style;
  return style ? new TextDecoder().decode(r.client.get(style)) : "";
};

describe("tailwindCandidates", () => {
  test("tokens of string literals and template chunks of ui/pages|patterns|sections, not imports or other files", () => {
    const files = new Map([
      [
        "ui/patterns/a.tsx",
        [
          'import { motion } from "motion/react";',
          // A template literal with a placeholder: both chunks are scanned.
          "const fooClass = `px-4 $" + "{1} md:py-2`;",
          'export default function A() { return <p className="bg-primary text-[13px] hover:underline">Привет мир</p>; }',
        ].join("\n"),
      ],
      [
        "ui/pages/Home.tsx",
        'const x = ["grid-cols-[minmax(0,1fr)_auto]", "https://vk.com/x", "/_wizard/a.webp"];',
      ],
      ["ui/sections/S.ts", "export const s = 'aspect-4/3 min-h-[min(88svh,52rem)]';"],
      ["ui/Landing.tsx", 'const v2 = "not-scanned";'],
      ["functions/f.ts", 'const f = "nor-this";'],
    ]);
    const c = tailwindCandidates(files);
    for (const t of [
      "px-4",
      "md:py-2",
      "bg-primary",
      "text-[13px]",
      "hover:underline",
      "grid-cols-[minmax(0,1fr)_auto]",
      "aspect-4/3",
      "min-h-[min(88svh,52rem)]",
    ])
      expect(c, t).toContain(t);
    for (const t of [
      "motion/react",
      "Привет",
      "https://vk.com/x",
      "/_wizard/a.webp",
      "not-scanned",
      "nor-this",
    ])
      expect(c, t).not.toContain(t);
  });

  test("a system is v3 exactly when it carries ui/design.css", () => {
    expect(isTailwindSystem(new Map([["ui/pages/Home.tsx", ""]]))).toBe(false);
    expect(isTailwindSystem(new Map([[DESIGN_CSS_PATH, ""]]))).toBe(true);
  });
});

describe("compileTailwind", () => {
  const fixture = DESIGN_FIXTURES[0];
  if (!fixture) throw new Error("no fixtures");
  const design = designCss(fixture);

  test("theme utilities over the design system, the default palette and fonts reset, the license header kept", async () => {
    const r = await compileTailwind(design, [
      "bg-primary",
      "text-hero",
      "font-display",
      "bg-red-500",
      "font-serif",
    ]);
    if (!r.ok) throw new Error(r.error);
    expect(/\.bg-primary\s*\{\s*background-color: var\(--color-primary\)/.test(r.css)).toBe(true);
    expect(/\.text-hero\s*\{\s*font-size: var\(--text-hero\)/.test(r.css)).toBe(true);
    for (const part of ["tailwindcss v4", "--ds-motion", "prefers-color-scheme: dark"])
      expect(r.css.includes(part), part).toBe(true);
    for (const part of [".bg-red-500", ".font-serif"]) expect(r.css.includes(part), part).toBe(false);
  });

  test("the design system may not import stylesheets, load plugins or configs, or pull CSS from other hosts", async () => {
    for (const [extra, what] of [
      ['@import "./other.css";', "./other.css"],
      ['@import "../../../.env";', "../../../.env"],
      ['@plugin "./steal.js";', "./steal.js"],
      ['@config "./tailwind.config.js";', "./tailwind.config.js"],
      ['@import url("https://fonts.googleapis.com/css2?family=Inter");', "https://fonts.googleapis.com"],
      ['@import "tailwindcss";', "tailwindcss"],
    ] as const) {
      const r = await compileTailwind(`${extra}\n${design}`, ["bg-primary"]);
      expect(r.ok, extra).toBe(false);
      if (!r.ok) expect(r.error, extra).toContain(what);
    }
  });

  test("layeredCss puts the ui-kit CSS between preflight and utilities", () => {
    const out = layeredCss("/*tw*/", "a{color:red}");
    expect(out.startsWith("@layer theme, base, wizard, components, utilities;")).toBe(true);
    expect(out).toContain("@layer wizard {\na{color:red}\n}");
  });
});

describe("buildSystem: v3 systems", () => {
  const fixture = DESIGN_FIXTURES[2];
  if (!fixture) throw new Error("no fixtures");
  const header = PATTERNS.find((p) => p.id === "header-classic");
  const hero = PATTERNS.find((p) => p.id === "hero-split");
  if (!header || !hero) throw new Error("patterns");

  test("a system with ui/design.css gets Tailwind in its CSS, the ui-kit CSS in layer «wizard», Motion in the JS", async () => {
    const { spec, files } = previewSystem(fixture, previewItems([header, hero]));
    const r = await buildSystem({ spec, files, env: "draft" });
    expect(r.errors).toEqual([]);
    const text = css(r);
    expect(text.startsWith("@layer theme, base, wizard, components, utilities;")).toBe(true);
    for (const part of ["tailwindcss v4", ".bg-primary{", "@layer wizard {"])
      expect(text.includes(part), part).toBe(true);
    expect(/--ds-motion:\s*lively/.test(text)).toBe(true);
    // The kit CSS (WzProvider's base.css with its document `a` rule) sits inside the layer, after Tailwind.
    expect(text.indexOf("@layer wizard {")).toBeGreaterThan(text.indexOf(".bg-primary{"));
    const js = clientText(r);
    // Motion's reduced-motion probe and AnimatePresence are in the bundle; one React (the SDK's).
    for (const part of ["prefers-reduced-motion", "AnimatePresence"])
      expect(js.includes(part), part).toBe(true);
    expect(js.match(/\/react\/index\.js"/g)?.length).toBe(1);
    const html = new TextDecoder().decode(r.client.get("index.html"));
    expect(html).toContain(`<link rel="stylesheet" href="/${r.manifest.entry.style}">`);
    // V3-18 (CLS): the cyrillic and latin faces of the design fonts load with the document, before the stylesheet.
    const preloads = [
      ...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g),
    ].map((m) => m[1] as string);
    expect(preloads.length).toBeGreaterThanOrEqual(2);
    expect(preloads.length).toBeLessThanOrEqual(8);
    for (const url of preloads) {
      expect(url).toMatch(/^\/_wizard\/fonts\/[\w.-]+-(cyrillic|latin)-\d{3}-[\w]+\.woff2$/);
      expect(text).toContain(url);
    }
    expect(preloads.some((u) => u.includes("-cyrillic-"))).toBe(true);
    expect(html.indexOf('rel="preload"')).toBeLessThan(html.indexOf('rel="stylesheet"'));
  });

  test("V3-18 (CLS): the first page of the public site is painted once its data loaded; other pages as they were", async () => {
    const solo = previewSystem(fixture, previewItems([header, hero]), { solo: true });
    const site = await buildSystem({ spec: solo.spec, files: solo.files, env: "prod" });
    expect(site.errors).toEqual([]);
    expect(clientText(site)).toContain('[aria-busy="true"]');
    expect(clientText(site)).toContain('["/"]');
    const { spec, files } = previewSystem(fixture, previewItems([header, hero]));
    const plain = await buildSystem({ spec, files, env: "prod" });
    expect(clientText(plain)).not.toContain('[aria-busy="true"]');
  });

  test("React and Motion are importable only in v3 systems; the headless hooks only once ui-kit ships them", async () => {
    const page =
      'import { motion } from "motion/react";\nimport { useState } from "react";\nexport default function P() { const [x] = useState(1); return <motion.p>{x}</motion.p>; }\n';
    const spec = {
      ...loadForum(),
      functions: [],
      pages: [{ route: "/", title: "Т", file: "ui/pages/P.tsx", roles: ["visitor"] }],
    };
    const v2 = await buildSystem({ spec, files: new Map([["ui/pages/P.tsx", page]]), env: "draft" });
    expect(v2.ok).toBe(false);
    expect(v2.errors.map((e) => e.evidence).join("\n")).toContain("Импорт «motion/react» запрещён");
    const v3 = await buildSystem({
      spec,
      files: new Map([
        ["ui/pages/P.tsx", page],
        [DESIGN_CSS_PATH, designCss(fixture)],
      ]),
      env: "draft",
    });
    expect(v3.errors).toEqual([]);
    const headless = await buildSystem({
      spec,
      files: new Map([
        [
          "ui/pages/P.tsx",
          'import { useLeadForm } from "@wizard/ui-kit/v3/headless";\nexport default function P() { useLeadForm("lead"); return null; }\n',
        ],
        [DESIGN_CSS_PATH, designCss(fixture)],
      ]),
      env: "draft",
      v3HostModules: { uiKitHeadless: null },
    });
    expect(headless.ok).toBe(false);
    expect(headless.errors.map((e) => e.evidence).join("\n")).toContain("motion/react");
  });

  test("a broken design system fails the build with G0-BUILD-01 on ui/design.css", async () => {
    const { spec, files } = previewSystem(fixture, previewItems([hero]));
    files.set(DESIGN_CSS_PATH, `@import "./x.css";\n${designCss(fixture)}`);
    const r = await buildSystem({ spec, files, env: "draft" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ id: "G0-BUILD-01", file: DESIGN_CSS_PATH });
    expect(r.errors[0]?.evidence).toContain("./x.css");
  });

  test("v2 systems are untouched: no Tailwind, no layer, and ui/design.css changes the CSS only", async () => {
    const v2 = await buildSystem({ spec: loadForum(), files: forumFiles(), env: "prod" });
    expect(v2.ok).toBe(true);
    expect(css(v2).includes("tailwindcss")).toBe(false);
    expect(css(v2).includes("@layer")).toBe(false);
    const withDesign = new Map(forumFiles());
    withDesign.set(DESIGN_CSS_PATH, designCss(fixture));
    const v3 = await buildSystem({ spec: loadForum(), files: withDesign, env: "prod" });
    expect(v3.ok).toBe(true);
    expect(v3.manifest.entry.script).toBe(v2.manifest.entry.script);
    expect(v3.manifest.entry.style).not.toBe(v2.manifest.entry.style);
    // Stub ui-kit (no CSS of its own): the v3 bundle gets a stylesheet with Tailwind alone.
    const stub = await build({ files: withDesign });
    expect(stub.manifest.entry.style).toMatch(/^assets\/index-[a-f0-9]{12}\.css$/);
    expect(css(stub).includes("@layer wizard")).toBe(false);
    expect(css(stub).includes("tailwindcss v4")).toBe(true);
  });
});

/** Class tokens a pattern applies: strings inside className attributes and the `…Class` constants they use. */
function classTokens(source: string): string[] {
  const sf = ts.createSourceFile("p.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = new Map<string, string>();
  const out = new Set<string>();
  const strings = (n: ts.Node, push: (s: string) => void): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      push(n.text);
    else if (ts.isIdentifier(n) && consts.has(n.text)) push(consts.get(n.text) ?? "");
    n.forEachChild((c) => strings(c, push));
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /Class$/.test(n.name.text) && n.initializer)
      strings(n.initializer, (s) => consts.set((n.name as ts.Identifier).text, s));
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "className" && n.initializer)
      strings(n.initializer, (s) => {
        for (const t of s.split(/\s+/)) if (t) out.add(t);
      });
    n.forEachChild(visit);
  };
  visit(sf);
  return [...out];
}

/** CSS.escape for a class name (what Tailwind writes in selectors). */
function escapeClass(s: string): string {
  return s
    .replace(/^(-?)(\d)/, (_, d: string, n: string) => `${d}\\3${n} `)
    .replace(/[^\w-]/g, (c) => `\\${c}`);
}

describe("patterns on the fixture design systems", () => {
  test("every fixture defines every theme variable the patterns rely on (the C2 contract for designSystemCss)", () => {
    for (const f of DESIGN_FIXTURES) {
      const text = designCss(f);
      for (const v of patternThemeVars()) expect(text, `${f.id}: ${v}`).toContain(`${v}:`);
    }
  });

  test("fixture palettes hold WCAG AA for every text pair, the scrim over white and over black", () => {
    const low = DESIGN_FIXTURES.flatMap(fixtureContrasts).filter((c) => c.ratio < 4.5);
    expect(low).toEqual([]);
  });

  test("every class of every pattern compiles on every fixture; colours, fonts, sizes and radii only from the theme", async () => {
    const tokens = new Map(PATTERNS.map((p) => [p.id, classTokens(p.source)]));
    const all = [...new Set([...tokens.values()].flat())];
    const allowed = new Set(patternThemeVars());
    const MARKERS = new Set(["group"]);
    for (const f of DESIGN_FIXTURES) {
      const r = await compileTailwind(designCss(f), all);
      if (!r.ok) throw new Error(r.error);
      const missing: string[] = [];
      for (const [id, list] of tokens)
        for (const t of list)
          if (!MARKERS.has(t) && !r.css.includes(`.${escapeClass(t)}`)) missing.push(`${id}: ${t}`);
      expect(missing, f.id).toEqual([]);
      const utilities = r.css.slice(r.css.indexOf("@layer utilities"));
      const used = new Set(
        [...utilities.matchAll(/var\((--(?:color|font(?!-weight)|text|radius)-[\w-]+?)(?:--[\w-]+)?\)/g)].map(
          (m) => m[1] as string,
        ),
      );
      const outside = [...used].filter(
        (v) => !allowed.has(v) && !/^--color-(inherit|current|transparent)$/.test(v),
      );
      expect(outside, f.id).toEqual([]);
    }
    // Each theme key is used by some pattern (the contract has no dead entries).
    const joined = [...tokens.values()].flat().join(" ");
    for (const c of PATTERN_THEME.color)
      expect(joined, c).toMatch(
        new RegExp(`(^|[\\s:-])(bg|text|border|outline|divide|decoration)-${c}(\\/\\d+)?(\\s|$)`),
      );
  });
});
