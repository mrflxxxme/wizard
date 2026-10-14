// V4-29 (acceptance build, defects 3 and 4): a catalog of a menu or goods shows no duration when its props say so
// (fields.duration null: «Капучино 200 ₽ / 2 ч» on a coffee house's home), services keep it; the team credits of
// people given by role only are one column of roles with a capital letter, never a table with an empty name column.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import CatalogGrid from "../src/v3/patterns/catalog/grid.js";
import { catalogSlots } from "../src/v3/patterns/catalog/index.js";
import CatalogTable from "../src/v3/patterns/catalog/table.js";
import { PATTERNS } from "../src/v3/patterns/index.js";
import TeamCredits from "../src/v3/patterns/team/credits.js";

const ITEMS = [{ id: "1", name: "Капучино", price: 200, duration_min: 120 }];
vi.mock("@wizard/ui-kit/v3/headless", async (actual) => ({
  ...(await actual<typeof import("@wizard/ui-kit/v3/headless")>()),
  useCatalog: () => ({
    items: ITEMS,
    isLoading: false,
    error: null,
    canRead: true,
    hasMore: false,
    more: () => {},
    total: ITEMS.length,
    category: null,
    setCategory: () => {},
    list: { refetch: () => {} },
  }),
}));

const preview = {
  title: "Меню",
  preview: true,
  itemAction: { label: "Заказать", path: "/booking" },
};

describe("V4-29 defect 3: no duration on the cards of a menu", () => {
  test("fields.duration null: the card has the price and the order, no «2 ч»", () => {
    expect(catalogSlots.safeParse({ ...preview, fields: { duration: null } }).success).toBe(true);
    const html = renderToStaticMarkup(h(CatalogGrid, { ...preview, fields: { duration: null } }));
    expect(html).toContain("Капучино");
    expect(html).toContain("Заказать");
    expect(html).not.toContain("2 ч");
    const table = renderToStaticMarkup(h(CatalogTable, { title: "Меню", fields: { duration: null } }));
    expect(table).not.toContain("Длительность");
    expect(table).not.toContain("2 ч");
  });

  test("services keep the duration (the module's field by default)", () => {
    const html = renderToStaticMarkup(
      h(CatalogGrid, { ...preview, itemAction: { label: "Записаться", path: "/booking" } }),
    );
    expect(html).toContain("2 ч");
    expect(renderToStaticMarkup(h(CatalogTable, { title: "Услуги" }))).toContain("Длительность");
  });
});

describe("V4-29 defect 4: the team credits of roles only", () => {
  const roles = [{ role: "стилист-колорист" }, { role: "стилист" }, { role: "мастер маникюра" }];

  test("no names: one column of roles with a capital letter, no empty name cells", () => {
    const credits = PATTERNS.find((p) => p.id === "team-credits");
    expect(credits?.slots.safeParse({ title: "Кто вас примет", people: roles }).success).toBe(true);
    // The variants that need a name to show do not take such a list.
    const others = PATTERNS.filter(
      (p) =>
        p.sectionType === "team" &&
        p.id !== "team-credits" &&
        p.slots.safeParse({ title: "x", people: roles }).success,
    );
    expect(others.map((p) => p.id)).toEqual([]);
    const html = renderToStaticMarkup(h(TeamCredits, { title: "Кто вас примет", people: roles }));
    expect(html).not.toContain("<dd");
    expect(html).not.toContain("<dl");
    expect(html.match(/<li/g)).toHaveLength(3);
    for (const r of ["Стилист-колорист", "Стилист", "Мастер маникюра"]) expect(html).toContain(`>${r}<`);
  });

  test("names given: the credits keep the role and the name side by side", () => {
    const html = renderToStaticMarkup(
      h(TeamCredits, {
        title: "Команда",
        people: [
          { name: "Дарья Орлова", role: "стилист-колорист" },
          { name: "Алина Шарипова", role: "стилист" },
        ],
      }),
    );
    expect(html.match(/<dd/g)).toHaveLength(2);
    expect(html).toContain(">Дарья Орлова<");
    expect(html).toContain(">стилист-колорист<");
  });
});
