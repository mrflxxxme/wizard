// @vitest-environment happy-dom
// GoalHints (ui-kit.yaml#components.GoalHints, B2-27): hint cards with an action link, the platform in a new tab,
// the empty state, the cabinet look.
import { createElement as h } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { forum } from "../demo/fixtures.js";
import { GoalHints } from "../src/index.js";
import { type Rendered, render } from "./helpers/dom.js";

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
});
const text = (el: Element) => (el.textContent ?? "").replace(/\s/g, " ");

const items = [
  {
    id: "reminder",
    title: "Много отмен записи",
    text: "Отменяется 23 % записей.",
    action: { label: "Изменить в Born to Build", href: "https://borntobuild.ru/", external: true },
  },
  {
    id: "leads",
    title: "Заявки без ответа",
    text: "В работу взято 40 % заявок.",
    action: { label: "Открыть заявки", href: "/cabinet#lead" },
  },
];

describe("GoalHints", () => {
  test("cards in order: title, text and the action; the platform opens in a new tab", async () => {
    r = await render(h(GoalHints, { items, subtitle: "по показателям за 30 дней" }), { app: forum });
    const root = r.$("wz-goalhints");
    expect(root.getAttribute("data-wz-component")).toBe("GoalHints");
    expect(root.getAttribute("data-wz-look")).toBe("cabinet");
    expect(root.querySelector("h2")?.textContent).toBe("Что улучшить");
    expect(text(root)).toContain("по показателям за 30 дней");
    const cards = root.querySelectorAll("li");
    expect([...cards].map((c) => c.getAttribute("data-testid"))).toEqual([
      "wz-goalhints-item-reminder",
      "wz-goalhints-item-leads",
    ]);
    const ext = r.$("wz-goalhints-action-reminder") as HTMLAnchorElement;
    expect(ext.getAttribute("href")).toBe("https://borntobuild.ru/");
    expect(ext.getAttribute("target")).toBe("_blank");
    expect(ext.getAttribute("rel")).toBe("noopener noreferrer");
    expect(text(ext)).toContain("Изменить в Born to Build");
    expect(text(ext)).toContain("откроется в новой вкладке");
    const own = r.$("wz-goalhints-action-leads") as HTMLAnchorElement;
    expect(own.getAttribute("href")).toBe("/cabinet#lead");
    expect(own.getAttribute("target")).toBeNull();
    expect(text(r.$("wz-goalhints-item-leads"))).toContain("В работу взято 40 % заявок.");
  });

  test("no hints — the empty state with its text", async () => {
    r = await render(h(GoalHints, { items: [], emptyText: "Подсказки появятся с данными" }), { app: forum });
    expect(text(r.$("wz-empty"))).toBe("Подсказки появятся с данными");
    expect(r.$("wz-goalhints").querySelectorAll("li")).toHaveLength(0);
  });
});
