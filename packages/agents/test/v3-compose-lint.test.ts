// V3-12 acceptance 2: the anti-slop linter of the public pages — design system tokens only, no forbidden defaults
// (Inter, purple gradients, a row of three equal cards, the default Tailwind palette, arbitrary colours and fonts), no
// invented facts (D49: superlatives, numbers not in the brief, placeholder copy), accessibility (alt, heading order,
// one h1, links that lead somewhere). Each rule has a failing and a clean case.
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import { patternById } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { copyIssues, type LintSection, lintPage, numbersOf } from "../src/builder/v3/compose/index.js";
import { SIGNATURE_OK } from "./v3-compose-fixtures.js";

const hero = patternById("hero-typographic");
const cta = patternById("cta-band");
if (!hero || !cta) throw new Error("library");
const HERO: LintSection = {
  id: "hero",
  type: "hero",
  pattern: hero.id,
  layout: hero.layout,
  source: hero.source,
  props: { title: "Лечим зубы без боли", action: { label: "Оставить заявку", href: "#form" } },
};

const sig = (source: string, props: unknown = {}): LintSection => ({
  id: "special",
  type: "signature",
  pattern: "signature",
  source,
  props,
});

const section = (body: string, head = "") =>
  `${head}export default function Special({ title }: { title: string }) {\n  return (\n    <section className="bg-background px-gutter py-section font-sans text-foreground">\n      <h2 className="font-display text-h2">{title}</h2>\n${body}\n    </section>\n  );\n}\n`;

const codes = (s: LintSection, extra: Partial<Parameters<typeof lintPage>[0]> = {}) =>
  lintPage({ sections: [HERO, s], numbers: new Set(["15"]), ...extra })
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

describe("copy rules (D49, catalog K, H)", () => {
  test("superlatives, placeholders, emoji, numbers outside the facts; facts and links are fine", () => {
    const facts = new Set(numbersOf("перезвоним за 15 минут, приём 2 500 ₽"));
    expect(copyIssues("Лучшая клиника города", facts).map((i) => i.code)).toContain("superlative");
    expect(copyIssues("Мы № 1 в Казани", facts).map((i) => i.code)).toContain("superlative");
    expect(copyIssues("Гарантируем результат", facts).map((i) => i.code)).toContain("superlative");
    expect(copyIssues("Lorem ipsum dolor", facts).map((i) => i.code)).toContain("placeholder");
    expect(copyIssues("Заголовок секции", facts).map((i) => i.code)).toContain("placeholder");
    expect(copyIssues("Запись онлайн ✨", facts).map((i) => i.code)).toContain("emoji");
    expect(copyIssues("Более 1000 довольных пациентов", facts).map((i) => i.code)).toContain(
      "untraced-number",
    );
    expect(copyIssues("Работаем с 2009 года", facts).map((i) => i.code)).toContain("untraced-number");
    expect(copyIssues("Уникальный индивидуальный подход", facts).map((i) => i.code)).toContain("stop-word");
    expect(copyIssues("Перезвоним за 15 минут", facts)).toEqual([]);
    expect(copyIssues("Первичный приём — 2 500 ₽", facts)).toEqual([]);
    expect(copyIssues("tel:+78432004050", facts)).toEqual([]);
  });
});

describe("section code (signature sections)", () => {
  test("a clean signature section passes", () => {
    expect(
      codes(sig(SIGNATURE_OK.source, SIGNATURE_OK.props), {
        numbers: new Set(),
      }),
    ).toEqual([]);
  });

  test("theme tokens only: arbitrary colour and font, default palette, raw colours, inline styles", () => {
    expect(codes(sig(section('      <p className="text-[#ff0000]">Текст</p>')))).toContain("arbitrary-color");
    expect(codes(sig(section('      <p className="font-[Inter]">Текст</p>')))).toContain("arbitrary-font");
    expect(codes(sig(section('      <p className="bg-blue-500 text-white">Текст</p>')))).toContain("palette");
    expect(codes(sig(section('      <p style={{ color: "#333" }}>Текст</p>')))).toContain("inline-style");
  });

  test("forbidden defaults: Inter and system fonts, purple gradients (also over a purple brand colour)", () => {
    expect(
      codes(sig(section('      <p className="text-body">Текст</p>', 'const FONT = "Inter, system-ui";\n'))),
    ).toContain("default-font");
    expect(
      codes(
        sig(
          section(
            '      <div className="h-2 bg-linear-to-r from-purple-500 to-primary" aria-hidden="true" />',
          ),
        ),
      ),
    ).toContain("purple-gradient");
    const purple = designSystemV3({
      archetype: "night_contrast",
      brandColor: "#7c5cff",
      seed: 1,
      niche: "клуб",
    });
    const themed = sig(
      section('      <div className="h-2 bg-linear-to-r from-primary to-inverse" aria-hidden="true" />'),
    );
    expect(codes(themed, { design: purple })).toContain("purple-gradient");
    expect(codes(themed)).not.toContain("purple-gradient");
  });

  test("three equal cards in a row (L01), emoji bullets, placeholder copy in code", () => {
    const cards = section(
      '      <div className="grid gap-6 md:grid-cols-3">\n        {["a", "b", "c"].map((k) => (\n          <div key={k} className="rounded-lg border border-border p-6">{k}</div>\n        ))}\n      </div>',
    );
    expect(codes(sig(cards))).toContain("three-cards");
    expect(codes(sig(section("      <p>🦷 Лечение без боли</p>")))).toContain("emoji");
    expect(codes(sig(section("      <p>Lorem ipsum</p>")))).toContain("placeholder");
    const props = { items: [{ title: "Быстро" }, { title: "Удобно" }, { title: "Надёжно" }] };
    expect(codes({ ...sig(SIGNATURE_OK.source), props })).toContain("three-cards");
  });

  test("accessibility: img without alt, meaningless alt, heading order, one h1", () => {
    expect(codes(sig(section('      <img src="/_wizard/photos/a/1600" />')))).toContain("img-alt");
    expect(codes({ ...sig(SIGNATURE_OK.source), props: { image: { src: "/x", alt: "фото" } } })).toContain(
      "weak-alt",
    );
    expect(codes(sig(section('      <h4 className="text-h3">Подзаголовок</h4>')))).toContain("heading-order");
    expect(codes(sig(section('      <h1 className="text-h1">Второй заголовок</h1>')))).toContain(
      "multiple-h1",
    );
    expect(lintPage({ sections: [sig(SIGNATURE_OK.source)] }).map((i) => i.code)).toContain("no-h1");
  });

  test("facts in code: numbers and claims in JSX text are invented facts", () => {
    expect(codes(sig(section("      <p>Более 1000 пациентов</p>")))).toEqual(
      expect.arrayContaining(["fabricated", "untraced-number"]),
    );
  });
});

describe("page rules", () => {
  test("the same layout family twice in a row (L06)", () => {
    const a = { ...HERO };
    const b: LintSection = {
      id: "cta",
      type: "cta",
      pattern: cta.id,
      layout: hero.layout,
      source: cta.source,
      props: { title: "Оставьте заявку", action: { label: "Оставить заявку", href: "#hero" } },
    };
    expect(lintPage({ sections: [a, b] }).map((i) => i.code)).toContain("layout-repeat");
    expect(lintPage({ sections: [a, { ...b, layout: cta.layout }] }).map((i) => i.code)).not.toContain(
      "layout-repeat",
    );
  });

  test("links lead to pages and anchors of the site", () => {
    const s: LintSection = {
      ...HERO,
      props: { title: "Клиника", action: { label: "Цены", href: "/prices" } },
    };
    expect(lintPage({ sections: [s], routes: ["/", "/services"] }).map((i) => i.code)).toContain(
      "broken-link",
    );
    const ok: LintSection = {
      ...HERO,
      props: { title: "Клиника", action: { label: "Цены", href: "/services" } },
    };
    expect(lintPage({ sections: [ok], routes: ["/", "/services"] }).map((i) => i.code)).not.toContain(
      "broken-link",
    );
    const anchor: LintSection = {
      ...HERO,
      props: { title: "Клиника", action: { label: "Заявка", href: "/#form" } },
    };
    expect(
      lintPage({ sections: [anchor], routes: ["/"], homeAnchors: ["hero"] }).map((i) => i.code),
    ).toContain("broken-link");
  });

  test("a design system with Inter is refused", () => {
    const ds = designSystemV3({ archetype: "calm_medical", seed: 1, niche: "клиника" });
    const inter = { ...ds, fonts: { ...ds.fonts, text: { ...ds.fonts.text, family: "Inter" } } };
    expect(lintPage({ sections: [HERO], design: inter }).map((i) => i.code)).toContain("default-font");
    expect(lintPage({ sections: [HERO], design: ds }).map((i) => i.code)).not.toContain("default-font");
  });
});
