// @vitest-environment happy-dom
// Header «split navigation» (rehearsal 13.10.2026): a long name — a description more than a brand — is not set in
// capitals and goes one size down, so it never pushes the two menu halves apart.
import { createElement as h } from "react";
import { afterEach, describe, expect, test } from "vitest";
import HeaderSplitNav from "../src/v3/patterns/header/split-nav.js";
import { type Rendered, render } from "./helpers/dom.js";

const nav = [
  { label: "Главная", href: "/" },
  { label: "Каталог и цены", href: "/services" },
  { label: "Запись", href: "/booking" },
];

describe("header split-nav: the brand", () => {
  let r: Rendered | undefined;
  afterEach(() => r?.unmount());

  test("no capitals; a long name is one size down, a short one keeps the heading size", async () => {
    r = await render(h(HeaderSplitNav, { brand: { name: "Стоматологическая клиника в Казани" }, nav }));
    const long = r.container.querySelector("header > div > a[href='/']") as HTMLElement;
    expect(long.className).not.toMatch(/\buppercase\b/);
    expect(long.className).toMatch(/\btext-lead\b/);
    r.unmount();
    r = await render(h(HeaderSplitNav, { brand: { name: "Белая линия" }, nav }));
    const short = r.container.querySelector("header > div > a[href='/']") as HTMLElement;
    expect(short.className).toMatch(/\btext-h3\b/);
  });
});
