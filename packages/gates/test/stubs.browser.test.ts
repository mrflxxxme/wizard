// V4-18 acceptance (page script in Chromium, 390 and 1440): the same kinds as the static pass, found in the DOM as the
// visitor sees it — dead links and buttons without a handler (React props on the node), placeholder texts and alt,
// empty sections, one phrase over the cards, cards without a photo, contacts not from the brief — each with its
// section; a clean page has none.
import { existsSync } from "node:fs";
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  knownContacts,
  STUB_CHECKS_SCRIPT,
  type StubPageOptions,
  type StubPageResult,
} from "../src/index.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const page = (sections: string) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>
<header><a href="/">Белая линия</a> <a href="/services">Каталог</a> <a href="tel:+79161234567">+7 916 123-45-67</a></header>
<main id="main">
  <div id="hero"><h1>Лечим зубы без боли и очередей</h1><a href="#form">Оставить заявку</a><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Кабинет клиники" width="10" height="10"></div>
  ${sections}
  <div id="form"><form><input placeholder="+7 (900) 000-00-00"><button type="submit" id="send">Отправить</button></form></div>
</main>
<footer><a href="mailto:hello@belaya-liniya.ru">hello@belaya-liniya.ru</a> <a href="/privacy">Политика</a></footer>
</body></html>`;

const CLEAN = `<div id="services"><h2>Почему мы</h2><ul class="grid">
  <li class="card"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Томограф" width="10" height="10"><p>Томографы и микроскопы в каждом кабинете</p></li>
  <li class="card"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Кресло" width="10" height="10"><p>Лечим без боли даже детей и взрослых</p></li>
</ul><button id="more">Показать ещё</button></div>`;

const DIRTY = `<div id="services"><h2>Заголовок</h2><ul class="grid">
  <li class="card"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Текст" width="10" height="10"><p>Качественно и быстро, с гарантией</p></li>
  <li class="card"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Кресло" width="10" height="10"><p>Качественно и быстро, с гарантией</p></li>
  <li class="card"><p>Lorem ipsum dolor sit amet</p></li>
</ul><a href="#">Подробнее</a> <a href="/prices">Цены</a> <a href="#reviews">Отзывы</a>
<button id="dead">Записаться</button><p>Звоните +7 (495) 765-43-21</p></div>
<div id="empty"><span>   </span></div>`;

const OPTS: StubPageOptions = {
  route: "/",
  routes: ["/", "/services"],
  contacts: knownContacts(["+7 (916) 123-45-67, hello@belaya-liniya.ru"]),
};

let browser: Browser;
beforeAll(async () => {
  if (hasChromium) browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

/** Runs the script on `html` at a width; buttons get React props (`__reactProps$t`) — #send and #more act, #dead not. */
async function run(html: string, width: number): Promise<StubPageResult> {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await p.setContent(html);
    await p.addScriptTag({ content: STUB_CHECKS_SCRIPT });
    return await p.evaluate((opts) => {
      for (const b of document.querySelectorAll("button"))
        (b as unknown as Record<string, unknown>).__reactProps$t =
          b.id === "dead" ? { children: "x" } : { onClick: () => {} };
      return (window as unknown as { __wzStubs: { run(o: unknown): StubPageResult } }).__wzStubs.run(opts);
    }, OPTS);
  } finally {
    await p.close();
  }
}

describe.skipIf(!hasChromium)("V4-18 stub checks in Chromium", () => {
  for (const width of [390, 1440]) {
    test(`${width}: a clean page has no findings`, async () => {
      expect((await run(page(CLEAN), width)).problems).toEqual([]);
    });

    test(`${width}: every kind is found, with its section`, async () => {
      const r = await run(page(DIRTY), width);
      const got = r.problems.map((x) => [x.code, x.section, x.literal]);
      expect(got).toEqual(
        expect.arrayContaining([
          ["S01", "services", "#"],
          ["S01", "services", "/prices"],
          ["S01", "services", "#reviews"],
          ["S01", "services", "Записаться"],
          ["S02", "services", "Заголовок"],
          ["S02", "services", "Lorem ipsum dolor sit amet"],
          ["S02", "services", "Текст"],
          ["S03", "services", "Качественно и быстро, с гарантией"],
          ["S03", "services", "1 из 3"],
          ["S03", "empty", "(пусто)"],
          ["S04", "services", "+7 (495) 765-43-21"],
        ]),
      );
      // The owner's contacts, the form's mask and the submit button are fine.
      expect(r.problems.some((x) => x.literal.includes("916") || x.literal.includes("belaya"))).toBe(false);
      expect(r.problems.some((x) => x.literal === "Отправить")).toBe(false);
      expect(r.problems.every((x) => x.selector.length > 0)).toBe(true);
    });
  }
});
