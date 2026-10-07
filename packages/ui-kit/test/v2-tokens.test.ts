// B2-32 acceptance (node): design system v2 tokens of grill-7, WCAG AA in both themes, safe business colour, motion only on
// transform/opacity with reduced motion off, glass fallback, self-hosted platform fonts with licenses (D64).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { blend, contrast } from "../src/tokens/color.js";
import {
  businessColors,
  PLATFORM_COLORS,
  PLATFORM_FONTS,
  type PlatformScheme,
  platformThemeCss,
  platformTokens,
  wirePath,
} from "../src/v2/index.js";
import { UI_KIT_ROOT } from "./helpers/demo.js";
import { cmapCodepoints, woff2Tables } from "./helpers/woff2.js";

const V2 = join(UI_KIT_ROOT, "src/v2");
const SCHEMES: PlatformScheme[] = ["light", "dark"];
const read = (p: string) => readFileSync(p, "utf8");
const v2Css = (): [string, string][] => {
  const files = [
    "theme.css",
    ...readdirSync(join(V2, "components"))
      .filter((f) => f.endsWith(".css"))
      .map((f) => `components/${f}`),
  ];
  return files.map((f) => [f, read(join(V2, f))]);
};

describe("tokens v2 (grill-7)", () => {
  test("src/v2/tokens.css is the output of platformThemeCss() (UPDATE_V2_CSS=1 rewrites it)", () => {
    const path = join(V2, "tokens.css");
    if (process.env.UPDATE_V2_CSS === "1") writeFileSync(path, platformThemeCss());
    expect(read(path)).toBe(platformThemeCss());
  });

  test("warm neutral palette and graphite + amber as decided (grill-7 #6, #8)", () => {
    const l = PLATFORM_COLORS.light;
    const d = PLATFORM_COLORS.dark;
    expect([l.bg, l.surface, l.ink, l.ink2, l.line]).toEqual([
      "#F8F7F4",
      "#FFFFFF",
      "#1D1C1A",
      "#6B6862",
      "#E9E6E0",
    ]);
    expect([d.bg, d.surface, d.ink, d.ink2]).toEqual(["#1B1A18", "#252421", "#EEECE7", "#A6A29A"]);
    expect([l.graphite, d.graphite]).toEqual(["#1D1C1A", "#EEECE7"]);
    expect([l.amber, l.amberGlow]).toEqual(["#D98A2B", "#F2B45C"]);
    const t = platformTokens("light");
    for (const k of ["--p-glass", "--p-glass-solid", "--p-grain", "--p-sh-2", "--p-tint", "--p-biz"] as const)
      expect(t[k], k).toBeTruthy();
  });

  // Text pairs the components use: [text, background, minimum].
  const pairs = (sc: PlatformScheme) => {
    const p = PLATFORM_COLORS[sc];
    const surfaces = [p.bg, p.surface, p.sunken, p.glassSolid];
    const out: [string, string, string, number][] = [];
    for (const bg of surfaces) {
      out.push(["ink", p.ink, bg, 4.5], ["ink-2", p.ink2, bg, 4.5]);
      out.push(["ok", p.ok, bg, 4.5], ["warn", p.warn, bg, 4.5], ["bad", p.bad, bg, 4.5]);
    }
    out.push(["ink on sunken-2", p.ink, p.sunken2, 4.5]);
    out.push(["graphite button", p.graphiteInk, p.graphite, 4.5]);
    out.push(["graphite hover", p.graphiteInk, p.graphiteHover, 4.5]);
    out.push(["amber «создать»", p.amberInk, p.amber, 4.5]);
    out.push(["amber hover", p.amberInk, p.amberGlow, 4.5]);
    out.push(["chosen chip", p.ink, blend(p.graphite, p.surface, 0.07), 4.5]);
    out.push(["focus ring (non-text)", p.graphite, p.bg, 3]);
    return out;
  };
  test.each(SCHEMES)("WCAG AA of the token pairs, %s", (sc) => {
    const bad = pairs(sc)
      .map(([name, fg, bg, min]) => [name, fg, bg, contrast(fg, bg), min] as const)
      .filter(([, , , r, min]) => r < min)
      .map(([n, fg, bg, r]) => `${n}: ${fg} on ${bg} = ${r.toFixed(2)}`);
    expect(bad).toEqual([]);
  });

  test("business colour: 4096 colours × 2 themes — fill visible ≥ 3:1, text on it and coloured text ≥ 4.5:1", () => {
    const bad: string[] = [];
    const steps = Array.from({ length: 16 }, (_, i) => (i * 17).toString(16).padStart(2, "0"));
    for (const r of steps)
      for (const g of steps)
        for (const b of steps) {
          const hex = `#${r}${g}${b}`.toUpperCase();
          for (const sc of SCHEMES) {
            const p = PLATFORM_COLORS[sc];
            const c = businessColors(hex, sc);
            const checks: [string, number, number][] = [
              ["ink on fill", contrast(c.bizInk, c.biz), 4.5],
              ["fill vs bg", contrast(c.biz, p.bg), 3],
              ["fill vs surface", contrast(c.biz, p.surface), 3],
              ["text on bg", contrast(c.bizText, p.bg), 4.5],
              ["text on surface", contrast(c.bizText, p.surface), 4.5],
              ["text on sunken", contrast(c.bizText, p.sunken), 4.5],
              ["text on soft", contrast(c.bizText, c.bizSoftSolid), 4.5],
              ["text on wash", contrast(c.bizText, c.bizWash), 4.5],
            ];
            for (const [n, v, min] of checks) if (v < min) bad.push(`${hex} ${sc} ${n}: ${v.toFixed(2)}`);
          }
        }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  test("no business colour or a malformed one → graphite; a good one is kept as is", () => {
    expect(businessColors(null, "light").biz).toBe("#1D1C1A");
    expect(businessColors("teal", "dark").biz).toBe("#EEECE7");
    expect(businessColors("#0f766e", "light").biz).toBe("#0F766E");
    expect(
      contrast(businessColors("#0F766E", "dark").biz, PLATFORM_COLORS.dark.surface),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("motion «материализация»", () => {
  const ALLOWED = new Set(["opacity", "transform"]);
  test("keyframes change only transform and opacity", () => {
    const bad: string[] = [];
    for (const [file, css] of v2Css()) {
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)) {
        for (const d of (m[2] ?? "").matchAll(/([a-z-]+)\s*:/g)) {
          if (!ALLOWED.has(d[1] as string)) bad.push(`${file} @keyframes ${m[1]}: ${d[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("transitions only on transform, opacity (and visibility switched without animation)", () => {
    const bad: string[] = [];
    for (const [file, css] of v2Css()) {
      for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
        const value = (m[1] ?? "").trim();
        if (value === "none !important" || value === "none") continue;
        for (const part of value.split(/,(?![^(]*\))/)) {
          const prop = part.trim().split(/\s+/)[0] ?? "";
          if (!ALLOWED.has(prop) && !(prop === "visibility" && /\b0s\b/.test(part)))
            bad.push(`${file}: ${part.trim()}`);
        }
      }
      if (/transition-property/.test(css)) bad.push(`${file}: transition-property`);
    }
    expect(bad).toEqual([]);
  });

  test("prefers-reduced-motion and data-p-motion=off switch every animation and transition off", () => {
    const theme = read(join(V2, "theme.css"));
    const reduce = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(theme)?.[1] ?? "";
    expect(reduce).toContain("[data-p-root] *");
    expect(reduce).toContain("animation: none !important");
    expect(reduce).toContain("transition: none !important");
    expect(theme).toMatch(/\[data-p-root\]\[data-p-motion="off"\] \*/);
  });
});

describe("glass", () => {
  test("solid fallback first, blur only under @supports and not with data-p-glass=off", () => {
    const css = read(join(V2, "components/controls.module.css"));
    const glass = /\n\.glass \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(glass).toContain("background: var(--p-glass-solid)");
    expect(glass).not.toContain("backdrop-filter");
    const sup =
      /@supports \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\) \{([\s\S]*?)\n\}/.exec(
        css,
      )?.[1];
    expect(sup).toContain(':global([data-p-root]:not([data-p-glass="off"])) .glass');
    expect(sup).toContain("backdrop-filter: blur(22px)");
    for (const [file, text] of v2Css())
      if (file !== "components/controls.module.css") expect(text, file).not.toContain("backdrop-filter");
  });
});

describe("platform fonts (D64)", () => {
  const DIR = join(UI_KIT_ROOT, "fonts-platform");
  const CYRILLIC = [...Array.from({ length: 0x44f - 0x410 + 1 }, (_, i) => 0x410 + i), 0x401, 0x451];

  test("Inter and Source Serif 4: OFL-1.1, license text, source and copyright; listed in THIRD_PARTY_NOTICES", () => {
    expect(PLATFORM_FONTS.map((f) => f.family)).toEqual(["Inter", "Source Serif 4"]);
    const notices = read(join(UI_KIT_ROOT, "../../THIRD_PARTY_NOTICES.md"));
    for (const f of PLATFORM_FONTS) {
      expect(f.license).toBe("OFL-1.1");
      expect(read(join(DIR, f.licenseFile))).toContain("SIL Open Font License");
      expect(f.attribution).toMatch(/Copyright/);
      expect(f.source).toMatch(/Google Fonts .*@fontsource\//);
      const line = notices.split("\n").find((l) => l.startsWith(`| ${f.family} |`));
      expect(line, f.family).toBeDefined();
      expect(line).toContain(f.license);
      expect(line).toContain(`@fontsource/${f.id}`);
    }
  });

  test("folder = catalog files + licenses; every cyrillic file has А–я, Ё, ё", () => {
    const files = PLATFORM_FONTS.flatMap((f) => f.files);
    expect(readdirSync(DIR).sort()).toEqual(
      [...files.map((x) => x.file), ...PLATFORM_FONTS.map((f) => f.licenseFile)].sort(),
    );
    for (const x of files.filter((x) => x.subset === "cyrillic")) {
      const cps = cmapCodepoints(
        woff2Tables(new Uint8Array(readFileSync(join(DIR, x.file)))).get("cmap") as Uint8Array,
      );
      expect(
        CYRILLIC.filter((cp) => !cps.has(cp)),
        x.file,
      ).toEqual([]);
    }
  });

  test("fonts.css: own files only (relative urls), swap, no CDN anywhere in v2", () => {
    const css = read(join(V2, "fonts.css"));
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(PLATFORM_FONTS.flatMap((f) => f.files).length);
    for (const u of urls) expect(u).toMatch(/^\.\.\/\.\.\/fonts-platform\/[a-z0-9-]+\.woff2$/);
    expect(css.match(/font-display: swap/g)).toHaveLength(urls.length);
    for (const [file, text] of v2Css())
      expect(text, file).not.toMatch(/googleapis|gstatic|https?:\/\/(?!www\.w3\.org)/);
  });
});

describe("x-ray lines", () => {
  test("wirePath: vertical links bend vertically, horizontal ones horizontally", () => {
    expect(wirePath({ x: 0, y: 0 }, { x: 10, y: 100 })).toBe("M0 0C0 55 10 45 10 100");
    expect(wirePath({ x: 0, y: 0 }, { x: 100, y: 10 })).toBe("M0 0C55 0 45 10 100 10");
  });
});
