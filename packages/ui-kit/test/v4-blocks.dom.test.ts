// @vitest-environment happy-dom
// V5-01 signature moments after hydration (D80 (4)): on a wide screen with motion allowed the chat messages and the
// oven hour start hidden and play in view; on 390 px and with prefers-reduced-motion they stay in their final frame.
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MMoment, NStatus } from "../src/index.js";
import { bakeryBlocks } from "../src/v3/bar/heroes/bakery.js";
import { serviceBlocks } from "../src/v3/bar/heroes/service.js";
import type { Photo } from "../src/v3/bar/still.js";
import { type Rendered, render } from "./helpers/dom.js";

const photo: Photo = { src: "/p.jpg", alt: "фото", credit: "Автор / Pexels" };
const photos = new Proxy({}, { get: () => photo }) as never;
const content = (id: string) =>
  [...bakeryBlocks(photos), ...serviceBlocks(photos)].find((b) => b.id === id)?.content as never;
const screen = (o: { wide: boolean; reduce: boolean }) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q.includes("reduce") ? o.reduce : q.includes("min-width") ? o.wide : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList,
  );
const hidden = (r: Rendered) =>
  [...r.container.querySelectorAll<HTMLElement>("li, span, p")].filter(
    (e) => e.style.opacity === "0" || /translateY\((100%|16px)\)|translateY\(16px\)/.test(e.style.transform),
  ).length;

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("signature moments after hydration", () => {
  test.each([
    { wide: false, reduce: false, name: "390 px" },
    { wide: true, reduce: true, name: "reduced motion" },
  ])("$name: the chat and the oven hour stand in their final frame", async (o) => {
    screen(o);
    r = await render(createElement(NStatus, { content: content("nochnoy-produkt.status") }));
    expect(r.container.querySelectorAll("li.border-l-4")).toHaveLength(4);
    expect(hidden(r)).toBe(0);
    r.unmount();
    r = await render(createElement(MMoment, { content: content("masterskaya.moment") }));
    expect(r.container.textContent).toContain("4:30");
    expect(hidden(r)).toBe(0);
  });

  test("wide screen with motion: messages wait to arrive", async () => {
    screen({ wide: true, reduce: false });
    r = await render(createElement(NStatus, { content: content("nochnoy-produkt.status") }));
    expect(hidden(r)).toBeGreaterThan(0);
  });
});
