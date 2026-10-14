// The footer «legal in full» without the owner's operator (a draft): the copyright stays under the contacts, the row
// «Оператор персональных данных» is not shown with «© <year> <site>» as its value (it read as a placeholder, rehearsal №5).
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import FooterLegalFull from "../src/v3/patterns/footer/legal-full.js";

const base = { brand: { name: "Белая линия" }, legal: { policy: { label: "Политика", href: "/privacy" } } };

describe("FooterLegalFull: the operator row only with the owner's operator", () => {
  test("a draft (© year site): no operator row, the copyright under the contacts", () => {
    const html = renderToStaticMarkup(
      h(FooterLegalFull, { ...base, legal: { ...base.legal, operator: "© 2026 Белая линия" } }),
    );
    expect(html).not.toContain("Оператор персональных данных");
    expect(html).toContain("© 2026 Белая линия");
    expect(html).toContain("Документы");
  });

  test("the owner's operator: the row is shown", () => {
    const html = renderToStaticMarkup(
      h(FooterLegalFull, { ...base, legal: { ...base.legal, operator: "ООО «Белая линия»" } }),
    );
    expect(html).toContain("Оператор персональных данных");
    expect(html).toContain("ООО «Белая линия»");
  });
});
