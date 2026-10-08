// V3-08 (node): the pattern library v3 — registry shape (8–12 variants per section type of this batch, ids, files,
// slot examples), licenses and origins (MIT / Apache-2.0 / own, never Tailwind Plus, Aceternity, Magic UI Pro, GSAP;
// each origin attributed in THIRD_PARTY_NOTICES.md), lintPattern on every pattern and on broken samples,
// deterministic and varied patternFor. The browser matrix is packages/build/test/patterns-v3.browser.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ALLOWED_PATTERN_LICENSES,
  FORBIDDEN_PATTERN_SOURCES,
  LAYOUT_FAMILIES,
  lintPattern,
  PATTERN_ORIGINS,
  PATTERNS,
  patternFiles,
  patternFor,
  patternThemeVars,
  SECTION_TYPES,
} from "../src/v3/patterns/index.js";
import { UI_KIT_ROOT } from "./helpers/demo.js";

const REPO = join(UI_KIT_ROOT, "../..");
/** Section types of this batch; the next batches add theirs to the list. */
const READY = ["header", "hero", "cta", "footer"] as const;

describe("registry", () => {
  test("every ready section type has 8–12 variants with unique ids, structurally different layouts", () => {
    for (const type of READY) {
      const of = PATTERNS.filter((p) => p.sectionType === type);
      expect(of.length, type).toBeGreaterThanOrEqual(8);
      expect(of.length, type).toBeLessThanOrEqual(12);
      expect(new Set(of.map((p) => p.variant)).size, type).toBe(of.length);
      // Structure, not recolouring: at least 6 layout families per type.
      expect(new Set(of.map((p) => p.layout)).size, type).toBeGreaterThanOrEqual(6);
    }
    expect(new Set(PATTERNS.map((p) => p.id)).size).toBe(PATTERNS.length);
  });

  test("ids, files, section types, layouts and archetypes are well formed", () => {
    for (const p of PATTERNS) {
      expect(p.id).toBe(`${p.sectionType}-${p.variant}`);
      expect(p.id).toMatch(/^[a-z]+(?:-[a-z0-9]+)+$/);
      expect(p.file).toBe(`ui/patterns/${p.id}.tsx`);
      expect(SECTION_TYPES).toContain(p.sectionType);
      expect(LAYOUT_FAMILIES).toContain(p.layout);
      expect(p.archetypes.length).toBeGreaterThan(0);
      expect(p.title).toMatch(/[а-яё]/i);
      expect(p.source.length).toBeGreaterThan(200);
    }
  });

  test("the example content of every pattern passes its slot schema (texts come through slots)", () => {
    for (const p of PATTERNS) {
      const r = p.slots.safeParse(p.example);
      expect(r.success, `${p.id}: ${r.error?.message}`).toBe(true);
    }
  });

  test("slots refuse photos from other hosts and links without a scheme we allow", () => {
    const hero = PATTERNS.find((p) => p.id === "hero-split");
    const ok = hero?.slots.safeParse(hero.example);
    expect(ok?.success).toBe(true);
    const ex = hero?.example as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>) => hero?.slots.safeParse({ ...ex, ...patch }).success;
    expect(bad({ image: { src: "https://images.unsplash.com/x.jpg", alt: "фото" } })).toBe(false);
    expect(bad({ image: { src: "//cdn.example.com/x.jpg", alt: "фото" } })).toBe(false);
    expect(bad({ image: { src: "/_wizard/photos/a.webp", alt: "" } })).toBe(false);
    expect(bad({ action: { label: "Записаться", href: "javascript:alert(1)" } })).toBe(false);
    expect(bad({ title: "x".repeat(91) })).toBe(false);
  });

  test("patternFiles gives the TSX to copy into the system, unknown ids throw", () => {
    const files = patternFiles(["hero-split", "footer-minimal"]);
    expect([...files.keys()]).toEqual(["ui/patterns/hero-split.tsx", "ui/patterns/footer-minimal.tsx"]);
    expect(files.get("ui/patterns/hero-split.tsx")).toContain("export default function HeroSplit");
    expect(() => patternFiles(["hero-nope"])).toThrow();
  });
});

describe("licenses (CI check, V3-08 acceptance 2)", () => {
  test("every pattern is own code or a rewrite of an MIT / Apache-2.0 source of the allowed list", () => {
    for (const p of PATTERNS) {
      expect(ALLOWED_PATTERN_LICENSES, p.id).toContain(p.license);
      if (p.origin === "own") expect(p.license, p.id).toBe("own");
      else {
        const o = PATTERN_ORIGINS[p.origin];
        expect(o, p.id).toBeDefined();
        expect(p.license, p.id).toBe(o.license);
      }
    }
  });

  test("no pattern, origin or dependency comes from Tailwind Plus, Aceternity, Magic UI Pro, React Bits Pro or GSAP", () => {
    const origins = Object.values(PATTERN_ORIGINS)
      .map((o) => `${o.name} ${o.url}`)
      .join("\n")
      .toLowerCase();
    const lock = readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8").toLowerCase();
    const pkgs = ["packages/ui-kit/package.json", "packages/build/package.json"]
      .map((f) => readFileSync(join(REPO, f), "utf8"))
      .join("\n")
      .toLowerCase();
    for (const s of FORBIDDEN_PATTERN_SOURCES)
      for (const m of s.markers) {
        expect(origins, s.id).not.toContain(m);
        for (const p of PATTERNS) expect(p.source.toLowerCase(), `${p.id}: ${s.id}`).not.toContain(m);
        if (!m.includes(" ")) {
          expect(lock, `${s.id} in pnpm-lock.yaml`).not.toMatch(new RegExp(`(^|[\\s/'"])${m}@`, "m"));
          expect(pkgs, s.id).not.toContain(`"${m}`);
        }
      }
  });

  test("every origin used by a pattern is attributed in THIRD_PARTY_NOTICES.md with its copyright line", () => {
    const notices = readFileSync(join(REPO, "THIRD_PARTY_NOTICES.md"), "utf8");
    const used = new Set(PATTERNS.map((p) => p.origin).filter((o) => o !== "own"));
    expect(used.size).toBeGreaterThan(0);
    for (const o of used) {
      const info = PATTERN_ORIGINS[o as keyof typeof PATTERN_ORIGINS];
      expect(notices.includes(info.url), `${o}: ${info.url}`).toBe(true);
      expect(notices.includes(info.copyright), `${o}: ${info.copyright}`).toBe(true);
    }
    for (const dep of ["tailwindcss", "motion", "framer-motion"])
      expect(notices.includes(dep), dep).toBe(true);
  });
});

describe("lintPattern", () => {
  test("every pattern of the library is clean", () => {
    const problems = Object.fromEntries(
      PATTERNS.map((p) => [
        p.id,
        lintPattern(p.source, p.file).map((i) => `${i.code}:${i.line} ${i.evidence}`),
      ]),
    );
    expect(Object.entries(problems).filter(([, v]) => v.length > 0)).toEqual([]);
  });

  const codes = (src: string) => [...new Set(lintPattern(src).map((i) => i.code))].sort();
  const wrap = (jsx: string, head = "") =>
    `${head}\nexport default function X() {\n  return (\n    ${jsx}\n  );\n}\n`;

  test("theme only: arbitrary colours and fonts, the default palette, raw colours and inline colour styles", () => {
    expect(codes(wrap('<p className="text-[#ff00aa]">a</p>'))).toEqual(["arbitrary-color", "raw-color"]);
    expect(codes(wrap('<p className="bg-(--brand) md:text-[15px]">a</p>'))).toEqual(["arbitrary-color"]);
    expect(codes(wrap('<p className="font-[Inter]">a</p>'))).toEqual(["arbitrary-font"]);
    expect(codes(wrap('<p className="bg-purple-600 hover:text-white">a</p>'))).toEqual(["palette"]);
    expect(codes(wrap('<p className="border-[#ccc]">a</p>'))).toEqual(["arbitrary-color", "raw-color"]);
    expect(codes(wrap('<p className="[color:red]">a</p>'))).toEqual(["arbitrary-color"]);
    expect(codes(wrap('<p style={{ color: "var(--x)" }}>a</p>'))).toEqual(["inline-style"]);
    expect(codes(wrap('<p className="bg-clip-text text-transparent">a</p>'))).toEqual(["slop"]);
    // Theme utilities and arbitrary layout values are fine.
    expect(
      codes(wrap('<p className="bg-primary text-primary-foreground border-[3px] aspect-[4/5]">a</p>')),
    ).toEqual([]);
  });

  test("imports: react, motion/react, the headless hooks and siblings only; no dynamic code", () => {
    expect(
      codes(wrap("<p>a</p>", 'import { useState } from "react";\nimport { motion } from "motion/react";')),
    ).toEqual([]);
    expect(codes(wrap("<p>a</p>", 'import { useLeadForm } from "@wizard/ui-kit/v3/headless";'))).toEqual([]);
    expect(codes(wrap("<p>a</p>", 'import gsap from "gsap";'))).toEqual(["forbidden-source", "import"]);
    expect(codes(wrap("<p>a</p>", 'import x from "../secret";'))).toEqual(["import"]);
    expect(codes(wrap("<p>a</p>", 'import { Hero } from "@wizard/ui-kit";'))).toEqual(["import"]);
    expect(codes(wrap('<div dangerouslySetInnerHTML={{ __html: "x" }} />'))).toEqual(["dynamic-code"]);
    expect(codes('const m = import("./x");\nexport default function X() { return null; }\n')).toEqual([
      "dynamic-code",
    ]);
    expect(codes("export function X() { return null; }\n")).toEqual(["default-export"]);
  });

  test("no invented facts or placeholder copy in the code (D49)", () => {
    expect(codes(wrap("<p>Более 1000 довольных клиентов</p>"))).toEqual(["fabricated"]);
    expect(codes(wrap("<p>Лучший сервис в городе</p>"))).toEqual(["fabricated"]);
    expect(codes(wrap("<p>Lorem ipsum</p>"))).toEqual(["fabricated"]);
    expect(codes(wrap('<p title="Иван Иванов">a</p>'))).toEqual(["fabricated"]);
    expect(codes(wrap("<p>Меню</p>"))).toEqual([]);
  });

  test("images with alt, buttons with type and name, links with href, name and colour, no clickable divs", () => {
    expect(codes(wrap('<img src="/a.webp" />'))).toEqual(["img-alt"]);
    expect(codes(wrap('<img src="/a.webp" alt="" />'))).toEqual(["img-alt"]);
    expect(codes(wrap('<img src="/a.webp" alt="" aria-hidden="true" />'))).toEqual([]);
    expect(codes(wrap("<button>Открыть</button>"))).toEqual(["button-type"]);
    expect(codes(wrap('<button type="button" />'))).toEqual(["button-name"]);
    expect(codes(wrap('<a className="text-foreground">Куда-то</a>'))).toEqual(["link-href"]);
    expect(codes(wrap('<a href="#" className="text-foreground">Куда-то</a>'))).toEqual(["link-href"]);
    expect(codes(wrap('<a href="/x" className="text-foreground" />'))).toEqual(["link-name"]);
    expect(codes(wrap('<a href="/x" className="underline">Куда-то</a>'))).toEqual(["link-color"]);
    expect(
      codes(wrap('<a href="/x" className={linkClass}>Куда-то</a>', 'const linkClass = "text-inherit";')),
    ).toEqual([]);
    expect(codes(wrap('<div onClick={() => {}} className="p-2">a</div>'))).toEqual(["click-target"]);
  });

  test("Motion animations respect prefers-reduced-motion", () => {
    const head = 'import { motion } from "motion/react";';
    expect(codes(wrap("<motion.p animate={{ opacity: 1 }}>a</motion.p>", head))).toEqual(["reduced-motion"]);
    expect(
      codes(
        wrap(
          "<motion.p animate={{ opacity: reduce ? 1 : 0.5 }}>a</motion.p>",
          'import { motion, useReducedMotion } from "motion/react";\nconst reduce = useReducedMotion();',
        ),
      ),
    ).toEqual([]);
  });
});

describe("patternFor", () => {
  test("deterministic: the same query gives the same pattern", () => {
    const q = { sectionType: "hero" as const, archetype: "reestr", seed: 42, used: ["header-classic"] };
    expect(patternFor(q)?.id).toBe(patternFor(q)?.id);
  });

  test("varied: seeds spread over the variants, used ones are skipped while fresh ones remain", () => {
    const picks = new Set<string>();
    for (let seed = 0; seed < 64; seed++)
      picks.add(patternFor({ sectionType: "hero", archetype: "atelie", seed })?.id ?? "");
    expect(picks.size).toBeGreaterThanOrEqual(6);
    const used: string[] = [];
    for (let i = 0; i < 8; i++) {
      const p = patternFor({ sectionType: "cta", archetype: "afisha", seed: 7, used });
      expect(p).not.toBeNull();
      expect(used).not.toContain(p?.id);
      used.push(p?.id ?? "");
    }
    // All eight used: a ninth call reuses one instead of failing.
    expect(patternFor({ sectionType: "cta", archetype: "afisha", seed: 7, used })?.sectionType).toBe("cta");
  });

  test("spreads layout families: a family already on the page loses to a fresh one", () => {
    const used = ["header-classic", "hero-split", "cta-split-image"];
    for (let seed = 0; seed < 32; seed++) {
      const p = patternFor({ sectionType: "footer", archetype: "zabota", seed, used });
      expect(["bar", "split"]).not.toContain(p?.layout);
    }
  });

  test("a section type without patterns yet gives null", () => {
    expect(patternFor({ sectionType: "blog", archetype: "reestr", seed: 1 })).toBeNull();
  });
});

describe("theme contract with the design system (C2)", () => {
  test("patterns use only utilities of the theme keys in PATTERN_THEME", () => {
    const vars = new Set(patternThemeVars());
    expect(vars.has("--color-primary")).toBe(true);
    expect(vars.has("--text-hero")).toBe(true);
    expect(vars.has("--ds-motion")).toBe(true);
    for (const p of PATTERNS)
      for (const m of p.source.matchAll(/--ds-[\w-]+/g))
        expect(vars.has(m[0]), `${p.id}: ${m[0]}`).toBe(true);
  });
});
