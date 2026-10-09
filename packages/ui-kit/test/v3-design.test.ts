// V3-07 acceptance (builder-v3.md#C2): 12–16 archetypes as data; the direction is sampled by seed from the niche, the
// goals and the niche's recent builds; tokens (D64 font pairs, OKLCH palette from the brand colour, scales, grid,
// rhythm, motion, imagery) are computed by code — designLint and themeLint without errors for every archetype × six
// brand colours × both schemes; on 12 synthetic briefs (3 per class) the archetype + token combinations differ
// (metric printed for the report). No models.
import { DESIGN_VOICES } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { themeLint } from "../src/themes/lint.js";
import { contrast, hexToOklch } from "../src/tokens/color.js";
import { FONT_CATALOG } from "../src/tokens/fonts.js";
import {
  ARCHETYPE_IDS,
  ARCHETYPES,
  COLOR_ROLES,
  cssHex,
  cyrillicFace,
  DESIGN_THEME_CSS,
  type DesignSystemV3,
  DISPLAY_ONLY_FONTS,
  designDiversity,
  designKey,
  designLint,
  designLintErrors,
  designSystemCss,
  designSystemTheme,
  designSystemV3,
  FORBIDDEN_FONTS,
  isCream,
  NEEDS_REASON_FONTS,
  NICHE_MEMORY,
  NOT_DISPLAY_FONTS,
  oklchCss,
  pickArchetype,
  pickArchetypes,
  schemeHex,
  systemClasses,
} from "../src/v3/design/index.js";

/** Six brand colours of the acceptance: red, blue, green, yellow, black, pink. */
const BRANDS = {
  red: "#D62828",
  blue: "#1D4ED8",
  green: "#2E7D32",
  yellow: "#FFD400",
  black: "#000000",
  pink: "#FF7EB6",
} as const;

/** 12 synthetic briefs of the measurement (D77 (18б)): three per class — site, booking, CRM/admin, shop. */
export const V3_DESIGN_BRIEFS = [
  {
    cls: "site",
    niche: "Архитектурное бюро: проекты частных домов",
    goals: ["Заявки на проектирование", "Портфолио работ"],
  },
  {
    cls: "site",
    niche: "Юридическая консультация для малого бизнеса",
    goals: ["Заявки на консультацию", "Разборы дел в блоге"],
    brandColor: "#1F3A5F",
  },
  {
    cls: "site",
    niche: "Пекарня-кондитерская, торты на заказ",
    goals: ["Заказы тортов", "Меню и цены"],
    brandColor: "#B5541B",
  },
  {
    cls: "booking",
    niche: "Стоматологическая клиника",
    goals: ["Онлайн-запись к врачу", "Цены и лицензия на виду"],
  },
  {
    cls: "booking",
    niche: "Студия маникюра и бровей",
    goals: ["Запись к мастеру онлайн", "Фото работ"],
    brandColor: "#E05A8A",
  },
  {
    cls: "booking",
    niche: "Детский развивающий центр",
    goals: ["Запись на пробное занятие", "Расписание групп"],
  },
  {
    cls: "admin",
    niche: "CRM для ремонтно-строительной компании",
    goals: ["Учёт заявок и смет", "Сделки и задачи сотрудников"],
    brandColor: "#F2A900",
  },
  {
    cls: "admin",
    niche: "Агентство недвижимости: внутренняя система",
    goals: ["Учёт объектов и сделок", "Воронка заявок"],
  },
  {
    cls: "admin",
    niche: "Диспетчерская грузоперевозок",
    goals: ["Учёт рейсов и водителей", "Отчёты по рейсам"],
    brandColor: "#0057B8",
  },
  {
    cls: "shop",
    niche: "Интернет-магазин натуральной косметики",
    goals: ["Продажи через каталог и корзину", "Оплата онлайн и доставка"],
  },
  {
    cls: "shop",
    niche: "Магазин керамики ручной работы",
    goals: ["Продажи через каталог", "Оплата онлайн"],
    brandColor: "#2F5D50",
  },
  {
    cls: "shop",
    niche: "Интернет-магазин одежды",
    goals: ["Продажи коллекций", "Доставка и оплата"],
  },
] as const;

const SCHEMES = ["light", "dark"] as const;
const CATALOG = new Set(FONT_CATALOG.map((f) => f.family));
const hueOf = (hex: string) => ((((hexToOklch(hex).h * 180) / Math.PI) % 360) + 360) % 360;

describe("archetypes as data", () => {
  test("12–16 archetypes with unique ids, Russian names, reasons and the rut they avoid", () => {
    expect(ARCHETYPES.length).toBeGreaterThanOrEqual(12);
    expect(ARCHETYPES.length).toBeLessThanOrEqual(16);
    expect(ARCHETYPES.map((a) => a.id)).toEqual([...ARCHETYPE_IDS]);
    expect(new Set(ARCHETYPES.map((a) => a.name)).size).toBe(ARCHETYPES.length);
    for (const a of ARCHETYPES) {
      expect(a.name, a.id).toMatch(/^[А-ЯЁ][а-яё -]+$/);
      expect(a.why.length, a.id).toBeGreaterThan(40);
      expect(a.why, a.id).toMatch(/[а-яё]/);
      expect(a.avoid.length, a.id).toBeGreaterThan(10);
      expect(a.niches.length, a.id).toBeGreaterThanOrEqual(10);
      for (const stem of a.niches) expect(stem, a.id).toBe(stem.toLowerCase());
      expect(a.goals.length, a.id).toBeGreaterThan(0);
      expect(a.classes.length, a.id).toBeGreaterThan(0);
      expect(a.voices.length, a.id).toBeGreaterThan(0);
      for (const v of a.voices) expect(DESIGN_VOICES, a.id).toContain(v);
      expect(a.scales.length * a.radius.length * a.density.length, a.id).toBeGreaterThan(0);
      expect(a.imagery.style, a.id).toMatch(/[а-яё]/);
    }
  });

  test("font pairs come from the self-hosted OFL catalog (D64) and follow the roles of catalog A3", () => {
    for (const a of ARCHETYPES) {
      expect(a.fontPairs.length, a.id).toBeGreaterThan(0);
      for (const p of a.fontPairs) {
        const where = `${a.id}: ${p.display} + ${p.text}`;
        expect(CATALOG.has(p.display), where).toBe(true);
        expect(CATALOG.has(p.text), where).toBe(true);
        expect(cyrillicFace(p.display, a.displayWeight), where).toBeDefined();
        for (const w of [400, 700]) expect(cyrillicFace(p.text, w), where).toBeDefined();
        expect(FORBIDDEN_FONTS.has(p.display) || FORBIDDEN_FONTS.has(p.text), where).toBe(false);
        expect(NOT_DISPLAY_FONTS.has(p.display), where).toBe(false);
        expect(DISPLAY_ONLY_FONTS.has(p.text), where).toBe(false);
        if (NEEDS_REASON_FONTS.has(p.display) || NEEDS_REASON_FONTS.has(p.text))
          expect(p.why ?? "", where).toMatch(/[а-яё]{10,}/);
      }
    }
  });

  test("the system never picks the violet of the «AI palette» itself; the dark archetype starts dark", () => {
    for (const a of ARCHETYPES)
      for (const h of a.palette.hues) expect(h >= 260 && h <= 310, a.id).toBe(false);
    expect(ARCHETYPES.filter((a) => a.palette.scheme === "dark").map((a) => a.id)).toEqual([
      "night_contrast",
    ]);
  });
});

describe("tokens by code: designSystemV3", () => {
  test("deterministic: the same input gives the same system and CSS; another seed varies the tokens", () => {
    for (const a of ARCHETYPES) {
      const input = { archetype: a.id, seed: "s-1", niche: "Кофейня у дома", brandColor: "#1D4ED8" };
      const x = designSystemV3(input);
      expect(designSystemV3({ ...input })).toEqual(x);
      expect(JSON.parse(JSON.stringify(x))).toEqual(x);
      expect(designSystemCss(designSystemV3(input))).toBe(designSystemCss(x));
    }
    // Without a brand colour the seed picks the accent (and pair, scale, radius, density among the options).
    const keys = new Set(
      Array.from({ length: 12 }, (_, i) =>
        designKey(designSystemV3({ archetype: "warm_craft", seed: i, niche: "Пекарня" })),
      ),
    );
    expect(keys.size).toBeGreaterThanOrEqual(6);
  });

  test("the brand colour is the accent of the light scheme exactly; without it — the archetype's hue", () => {
    for (const a of ARCHETYPES)
      for (const brand of Object.values(BRANDS)) {
        const ds = designSystemV3({ archetype: a.id, brandColor: brand, seed: 7, niche: "Тест" });
        expect(ds.palette.source).toBe("brand");
        expect(cssHex(ds.palette.light.accent), `${a.id} ${brand}`).toBe(brand);
        expect(ds.palette.light.accent).toMatch(/^oklch\(/);
      }
    const ds = designSystemV3({ archetype: "calm_medical", seed: 7, niche: "Клиника" });
    expect(ds.palette.source).toBe("archetype");
    const h = hueOf(cssHex(ds.palette.light.accent));
    expect(
      ARCHETYPES.find((a) => a.id === "calm_medical")?.palette.hues.some((x) => Math.abs(x - h) <= 12),
    ).toBe(true);
  });

  test.each(ARCHETYPES.map((a) => [a.id] as const))(
    "%s × six brand colours and none × both schemes: designLint and themeLint without errors",
    (id) => {
      for (const [name, brand] of [["none", undefined], ...Object.entries(BRANDS)] as const)
        for (const seed of ["a", "b", "c"]) {
          const ds = designSystemV3({ archetype: id, brandColor: brand, seed, niche: "Тест" });
          const issues = designLintErrors(ds);
          for (const scheme of SCHEMES)
            expect(
              issues.filter((i) => i.scheme === scheme),
              `${id} ${name} ${seed} ${scheme}`,
            ).toEqual([]);
          expect(issues, `${id} ${name} ${seed}`).toEqual([]);
          const notes = themeLint(designSystemTheme(ds)).map((n) => n.code);
          expect(notes).not.toContain("UNKNOWN_FONT");
          expect(notes).not.toContain("UNKNOWN_PRESET");
        }
    },
  );

  test("contrast holds for any brand colour (5×5×5 grid × every archetype, both schemes)", () => {
    const lv = [0, 64, 128, 191, 255].map((n) => n.toString(16).padStart(2, "0"));
    for (const a of ARCHETYPES)
      for (const r of lv)
        for (const g of lv)
          for (const b of lv) {
            const brand = `#${r}${g}${b}`.toUpperCase();
            const ds = designSystemV3({ archetype: a.id, brandColor: brand, seed: brand, niche: "Сетка" });
            expect(designLintErrors(ds), `${a.id} ${brand}`).toEqual([]);
            expect(cssHex(ds.palette.light.accent)).toBe(brand);
          }
  });

  test("the palette by hand: text ≥ 4.5:1, buttons and borders ≥ 3:1, never cream or pure black", () => {
    for (const a of ARCHETYPES)
      for (const brand of Object.values(BRANDS)) {
        const ds = designSystemV3({ archetype: a.id, brandColor: brand, seed: 1, niche: "Тест" });
        for (const scheme of SCHEMES) {
          const h = schemeHex(ds.palette[scheme]);
          for (const bg of [h.bg, h.surface, h.surfaceAlt]) {
            expect(contrast(h.ink, bg)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(h.muted, bg)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(h.accentText, bg)).toBeGreaterThanOrEqual(4.5);
          }
          expect(contrast(h.accentInk, h.accent)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(h.accentEdge, h.bg)).toBeGreaterThanOrEqual(3);
          expect(contrast(h.border, h.surface)).toBeGreaterThanOrEqual(3);
          for (const role of ["bg", "surface", "ink", "muted"] as const) expect(h[role]).not.toBe("#000000");
          if (scheme === "light")
            for (const bg of [h.bg, h.surface, h.surfaceAlt]) expect(isCream(bg)).toBe(false);
        }
      }
  });

  test("type scale, grid, rhythm, motion and imagery follow the catalog (E1–E3)", () => {
    for (const a of ARCHETYPES) {
      const ds = designSystemV3({ archetype: a.id, seed: 3, niche: "Тест" });
      const t = ds.type.steps;
      expect(t.display.max / t.base.max).toBeGreaterThanOrEqual(2.5);
      expect(t.display.max).toBeLessThanOrEqual(72);
      expect(t.base.min).toBeGreaterThanOrEqual(16);
      expect(t.sm.min).toBeGreaterThanOrEqual(13);
      expect(t.display.size).toMatch(/^clamp\([\d.]+rem, [\d.-]+rem \+ [\d.]+vw, [\d.]+rem\)$/);
      expect(ds.fonts.display.family).toBe(
        a.fontPairs.find((p) => p.display === ds.fonts.display.family)?.display,
      );
      expect(ds.grid.columns).toBe(12);
      expect(ds.grid.measure).toBeGreaterThanOrEqual(40);
      expect(ds.grid.measure).toBeLessThanOrEqual(75);
      expect(ds.grid.rhythm.section.desktop).toBeGreaterThan(ds.grid.rhythm.section.mobile);
      expect(ds.motion.durations.state).toBe(120);
      expect(ds.motion.durations.hero).toBeLessThanOrEqual(600);
      if (ds.motion.profile === "still") expect(ds.motion.entrance).toBe("none");
      expect(ds.imagery.style).toBe(a.imagery.style);
      expect(ds.voice).toBe(a.voices[0]);
    }
  });
});

describe("designSystemCss", () => {
  const ds = designSystemV3({ archetype: "night_contrast", brandColor: "#FFD400", seed: 2, niche: "Бар" });
  const css = designSystemCss(ds, { fonts: true });

  test("variables of both schemes, the starting one on :root; colours only as oklch()", () => {
    expect(css).toContain(":root{");
    expect(css).toContain(":root[data-scheme=light]{");
    expect(css).toContain(":root[data-scheme=dark]{");
    expect(css).toContain("@media (prefers-color-scheme: light){:root[data-scheme=auto]{");
    for (const role of COLOR_ROLES) {
      const name = `--ds-color-${role.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:`;
      expect(css.split(name).length - 1, name).toBe(4);
    }
    // night_contrast starts dark: :root carries the dark palette.
    expect(css).toContain(`--ds-color-bg:${ds.palette.dark.bg};`);
    expect(css.slice(css.indexOf(":root{"), css.indexOf(":root[data-scheme"))).toContain(ds.palette.dark.bg);
    expect(css.replace(/@font-face\{[^}]*\}/g, "")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  test("@theme inline for Tailwind v4 bound to the variables, defaults cleared", () => {
    expect(css).toContain(DESIGN_THEME_CSS);
    for (const s of [
      "--color-*: initial;",
      "--font-*: initial;",
      "--color-bg: var(--ds-color-bg);",
      "--color-accent-ink: var(--ds-color-accent-ink);",
      "--font-display: var(--ds-font-display);",
      "--font-text: var(--ds-font-text);",
      "--radius-control: var(--ds-radius-control);",
      "--spacing: 0.25rem;",
      "--text-display: var(--ds-text-display);",
      "--animate-hero: var(--ds-anim-hero);",
    ])
      expect(DESIGN_THEME_CSS).toContain(s);
    // The theme block is the same for every system: one Tailwind build serves several scopes (three directions).
    const other = designSystemV3({ archetype: "luxury", seed: 9, niche: "Ювелир" });
    expect(designSystemCss(other)).toContain(DESIGN_THEME_CSS);
    const scoped = designSystemCss(other, { scope: "[data-direction=b]", theme: false });
    expect(scoped).not.toContain("@theme");
    expect(scoped).toContain("[data-direction=b]{");
    expect(scoped).toContain("[data-direction=b][data-scheme=dark]{");
  });

  test("fonts only from the catalog, reduced motion keeps content visible, motion from the profile", () => {
    const faces = css.match(/@font-face\{[^}]*\}/g) ?? [];
    // Two families × 400/700 × cyrillic, latin and latin-ext (₽, V3-08).
    expect(faces.length).toBe(12);
    expect(faces.filter((f) => f.includes("U+20AD-20C0"))).toHaveLength(4);
    for (const f of faces)
      expect([ds.fonts.display.family, ds.fonts.text.family].some((n) => f.includes(`"${n}"`))).toBe(true);
    expect(css).toContain(
      "@media (prefers-reduced-motion: reduce){:root{--ds-anim-hero:wz-fade 150ms linear both;",
    );
    expect(css).toContain("--ds-anim-reveal:none;");
    expect(css).toContain("--ds-anim-hero:wz-rise 600ms var(--ds-ease-out) both;");
    const still = designSystemCss(designSystemV3({ archetype: "swiss", seed: 1, niche: "Бюро" }));
    expect(still).toContain("--ds-anim-hero:none;");
  });
});

describe("designLint catches what it must", () => {
  const base = designSystemV3({ archetype: "editorial", seed: 1, niche: "Блог" });
  const codes = (ds: DesignSystemV3) => designLint(ds).map((i) => `${i.severity}:${i.code}`);

  test("Inter, a monoculture display face, a display face as text, a model default without a reason", () => {
    const font = (family: string) => ({ family, weight: 700, stack: `"${family}"` });
    expect(codes({ ...base, fonts: { ...base.fonts, display: font("Inter Tight") } })).toEqual(
      expect.arrayContaining(["error:FORBIDDEN_FONT", "error:DISPLAY_FONT_BANNED"]),
    );
    expect(codes({ ...base, fonts: { ...base.fonts, text: font("Unbounded") } })).toEqual(
      expect.arrayContaining(["error:DISPLAY_FONT_AS_TEXT", "error:FONT_REASON_MISSING"]),
    );
    expect(codes({ ...base, fonts: { ...base.fonts, display: font("Roboto Slab") } })).toEqual(
      expect.arrayContaining(["error:UNKNOWN_FONT", "error:THEME_LINT"]),
    );
  });

  test("violet accent picked by the system, cream page, low contrast, pure black, springy and long motion", () => {
    const violet = oklchCss("#7C3AED");
    const light = { ...base.palette.light, accent: violet };
    expect(codes({ ...base, palette: { ...base.palette, light } })).toContain("error:AI_PALETTE");
    expect(codes({ ...base, palette: { ...base.palette, source: "brand", light } })).not.toContain(
      "error:AI_PALETTE",
    );
    const cream = { ...base.palette.light, bg: oklchCss("#F5EFE3") };
    expect(codes({ ...base, palette: { ...base.palette, light: cream } })).toContain("error:CREAM_BG");
    const grey = { ...base.palette.dark, muted: oklchCss("#555555"), bg: oklchCss("#000000") };
    expect(codes({ ...base, palette: { ...base.palette, dark: grey } })).toEqual(
      expect.arrayContaining(["error:TEXT_CONTRAST", "error:PURE_BLACK"]),
    );
    const motion = {
      ...base.motion,
      easing: { ...base.motion.easing, out: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
      durations: { ...base.motion.durations, overlay: 500 },
    };
    expect(codes({ ...base, motion })).toEqual(
      expect.arrayContaining(["error:MOTION_OVERSHOOT", "error:MOTION_TOO_LONG"]),
    );
  });
});

describe("pickArchetype: seeded sampler with niche memory", () => {
  const brief = V3_DESIGN_BRIEFS[3];

  test("deterministic by seed; the niche and goals decide which archetypes are drawn", () => {
    const input = { niche: brief.niche, goals: brief.goals, seed: "x" };
    expect(pickArchetype(input)).toEqual(pickArchetype({ ...input }));
    const drawn = new Set(Array.from({ length: 40 }, (_, i) => pickArchetype({ ...input, seed: i }).id));
    expect(drawn.size).toBeGreaterThanOrEqual(2);
    expect(drawn.has("calm_medical")).toBe(true);
    for (const id of drawn)
      expect(["calm_medical", "swiss", "soft_organic", "classic_business"]).toContain(id);
    const kids = new Set(
      Array.from(
        { length: 40 },
        (_, i) => pickArchetype({ niche: "Детский клуб", goals: ["Запись в группы"], seed: i }).id,
      ),
    );
    expect(kids.has("playful_kids")).toBe(true);
    expect(kids.has("calm_medical")).toBe(false);
  });

  test("goals and class count: a CRM brief draws working-screen archetypes", () => {
    expect(systemClasses("CRM для стройки", ["Учёт сделок"])).toEqual(["admin"]);
    const drawn = new Set(
      Array.from(
        { length: 40 },
        (_, i) =>
          pickArchetype({
            niche: "Внутренняя система учёта",
            goals: ["Учёт сделок и задач сотрудников"],
            seed: i,
          }).id,
      ),
    );
    for (const id of drawn)
      expect(["tech_minimal", "classic_business", "neat_brutalism", "swiss"]).toContain(id);
  });

  test("the last builds of the niche are not repeated while a fitting alternative exists", () => {
    const recent: string[] = [];
    for (let k = 0; k < 10; k++) {
      const p = pickArchetype({ niche: brief.niche, goals: brief.goals, seed: `build-${k}`, recent });
      expect(recent.slice(0, NICHE_MEMORY), `build ${k}`).not.toContain(p.id);
      expect(p.fit).toBeGreaterThan(0);
      recent.unshift(p.id);
    }
    // Memory off: the same seed may repeat the last build.
    const first = pickArchetype({ niche: brief.niche, goals: brief.goals, seed: "s" });
    const again = pickArchetype({
      niche: brief.niche,
      goals: brief.goals,
      seed: "s",
      recent: [first.id],
      memory: 0,
    });
    expect(again.id).toBe(first.id);
    const avoid = pickArchetype({ niche: brief.niche, goals: brief.goals, seed: "s", recent: [first.id] });
    expect(avoid.id).not.toBe(first.id);
    expect(avoid.avoided).toContain(first.id);
  });

  test("when every remaining archetype is recent, the very last build is still not repeated", () => {
    const keep = ["calm_medical", "swiss"];
    const exclude = ARCHETYPE_IDS.filter((id) => !keep.includes(id));
    const p = pickArchetype({ niche: brief.niche, goals: brief.goals, seed: 1, exclude, recent: keep });
    expect(p.id).toBe("swiss");
  });

  test("pickArchetypes gives three different candidates, the first is pickArchetype", () => {
    for (const b of V3_DESIGN_BRIEFS) {
      const input = { niche: b.niche, goals: b.goals, seed: "c" };
      const three = pickArchetypes(input, 3);
      expect(new Set(three.map((p) => p.id)).size).toBe(3);
      expect(three[0]?.id).toBe(pickArchetype(input).id);
    }
  });
});

describe("12 briefs of the measurement: combinations differ", () => {
  test("archetype and tokens per brief (3 per class), diversity metric", () => {
    expect(V3_DESIGN_BRIEFS.length).toBe(12);
    for (const cls of ["site", "booking", "admin", "shop"])
      expect(V3_DESIGN_BRIEFS.filter((b) => b.cls === cls).length).toBe(3);
    const systems = V3_DESIGN_BRIEFS.map((b, i) => {
      const seed = `v3-brief-${i + 1}`;
      const pick = pickArchetype({ niche: b.niche, goals: b.goals, seed });
      const brandColor = "brandColor" in b ? b.brandColor : undefined;
      return designSystemV3({
        archetype: pick.id,
        seed,
        niche: b.niche,
        ...(brandColor ? { brandColor } : {}),
      });
    });
    for (const ds of systems) expect(designLintErrors(ds), ds.niche).toEqual([]);
    const d = designDiversity(systems);
    const rows = systems.map(
      (ds) =>
        `  ${ds.niche} → ${ds.name} (${ds.fonts.display.family} + ${ds.fonts.text.family}, ${cssHex(ds.palette.light.accent)}, ${ds.type.scale}, ${ds.radius.set}, ${ds.grid.rhythm.density}, ${ds.motion.profile})`,
    );
    console.info(
      `V3-07 разнообразие на 12 брифах: архетипов ${d.archetypes}, пар шрифтов ${d.fontPairs}, уникальных сочетаний ${d.uniqueCombos}/${d.count} (${d.comboShare}), расстояние min ${d.minDistance} / среднее ${d.meanDistance}\n${rows.join("\n")}`,
    );
    expect(d.uniqueCombos).toBe(12);
    expect(d.comboShare).toBe(1);
    expect(d.archetypes).toBeGreaterThanOrEqual(8);
    expect(d.meanDistance).toBeGreaterThanOrEqual(0.6);
    // Two briefs of different niches may share an archetype (memory is per niche); their tokens still differ.
    expect(d.minDistance).toBeGreaterThanOrEqual(0.1);
    for (let i = 0; i < systems.length; i++)
      for (let j = i + 1; j < systems.length; j++) {
        const a = systems[i] as DesignSystemV3;
        const b = systems[j] as DesignSystemV3;
        if (a.archetype !== b.archetype) continue;
        const same = (f: (x: DesignSystemV3) => unknown) => f(a) === f(b);
        expect(
          same((x) => cssHex(x.palette.light.accent)),
          `${a.niche} / ${b.niche}`,
        ).toBe(false);
        const tokens = [
          (x: DesignSystemV3) => `${x.fonts.display.family}+${x.fonts.text.family}`,
          (x: DesignSystemV3) => x.type.scale,
          (x: DesignSystemV3) => x.radius.set,
          (x: DesignSystemV3) => x.grid.rhythm.density,
          (x: DesignSystemV3) => x.grid.layout,
        ];
        expect(tokens.filter((f) => !same(f)).length, `${a.niche} / ${b.niche}`).toBeGreaterThanOrEqual(1);
      }
    // Within a class the three briefs get three different archetypes.
    for (const cls of ["site", "booking", "admin", "shop"]) {
      const ids = systems.filter((_, i) => V3_DESIGN_BRIEFS[i]?.cls === cls).map((ds) => ds.archetype);
      expect(new Set(ids).size, cls).toBeGreaterThanOrEqual(2);
    }
  });
});
