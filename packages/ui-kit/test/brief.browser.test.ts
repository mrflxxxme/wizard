// V3-06 acceptance in chromium on the demo page demo/brief, 390 and 1280 px × light and dark: the short brief (5–8 theses,
// three diagram thumbnails that open the panel), the panel (versions with the difference highlighted, the diagrams,
// sessions), the diagrams drawn by our layout — no node overlaps a node, no label overlaps a node or a label, the real
// glyphs fit their boxes, no horizontal scroll — and the edit in the panel that goes to onSave with baseVersion and
// becomes a new version. Contrast, labels and touch targets by the shared a11y script; screenshots in test/artifacts.
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "./a11y/checks.js";
import { ARTIFACTS, type DemoHarness, hasChromium, startDemo } from "./helpers/demo.js";

async function a11y<K extends keyof A11yApi>(page: Page, check: K) {
  await page.addScriptTag({ content: A11Y_SCRIPT });
  return page.evaluate(
    (c) => (window as unknown as { __a11y: Record<string, () => unknown> }).__a11y[c]?.(),
    check,
  ) as Promise<ReturnType<A11yApi[K]>>;
}

/** Geometry problems of every diagram on the page, measured on the rendered SVG. */
function diagramProblems(page: Page, scope: string) {
  return page.evaluate((sel) => {
    const out: string[] = [];
    type Box = { id: string; x: number; y: number; w: number; h: number };
    const box = (id: string, el: SVGGraphicsElement): Box => {
      const b = el.getBBox();
      return { id, x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const cross = (a: Box, b: Box) =>
      Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
      Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
    const figs = [...document.querySelectorAll(sel)];
    if (figs.length === 0) out.push(`no diagrams for ${sel}`);
    for (const fig of figs) {
      const name = fig.getAttribute("data-testid");
      const frame = fig.querySelector('[data-testid="p-brief-frame"]') as HTMLElement;
      const svg = frame.querySelector("svg") as SVGSVGElement;
      if (svg.getBoundingClientRect().width > frame.clientWidth + 1)
        out.push(`${name}: svg ${svg.getBoundingClientRect().width} > frame ${frame.clientWidth}`);
      const nodes: Box[] = [];
      for (const g of fig.querySelectorAll('[data-testid^="p-brief-node-"]')) {
        const id = g.getAttribute("data-testid") as string;
        const rect = g.querySelector("rect") as SVGRectElement;
        const r = box(id, rect);
        nodes.push(r);
        const text = g.querySelector("text") as SVGTextElement;
        const t = text.getBBox();
        if (t.x < r.x + 4 || t.x + t.width > r.x + r.w - 4 || t.y < r.y || t.y + t.height > r.y + r.h)
          out.push(
            `${name} ${id}: text ${t.x},${t.y} ${t.width}×${t.height} outside ${r.x},${r.y} ${r.w}×${r.h}`,
          );
        for (const span of text.querySelectorAll("tspan"))
          if (span.getComputedTextLength() > r.w - 2 * 12 + 1)
            out.push(
              `${name} ${id}: line «${span.textContent}» ${span.getComputedTextLength()} > ${r.w - 24}`,
            );
      }
      const labels: Box[] = [];
      for (const g of fig.querySelectorAll('[data-testid="p-brief-edge-label"]')) {
        const rect = g.querySelector("rect") as SVGRectElement;
        const l = box(`label «${g.textContent}»`, rect);
        labels.push(l);
        const t = (g.querySelector("text") as SVGTextElement).getBBox();
        if (t.x < l.x || t.x + t.width > l.x + l.w + 0.5)
          out.push(`${name} ${l.id}: text wider than its pill`);
      }
      const all = [...nodes, ...labels];
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i] as Box;
          const b = all[j] as Box;
          if (cross(a, b)) out.push(`${name}: ${a.id} overlaps ${b.id}`);
        }
    }
    return out;
  }, scope);
}

const settle = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => true));
const saves = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __wz: { saves: { baseVersion: number; brief: unknown }[] } }).__wz.saves,
  );

describe.skipIf(!hasChromium)("«Бриф» components in chromium", () => {
  let demo: DemoHarness;
  beforeAll(async () => {
    demo = await startDemo("brief");
  }, 120_000);
  afterAll(async () => demo?.close());

  const SIZES = [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ] as const;

  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: short brief, diagrams without overlaps, panel; contrast, labels, no scroll`, async () => {
        const tag = `${vp.width}-${scheme}`;
        const page = await demo.page({
          path: "brief/",
          query: `theme=${scheme}`,
          viewport: vp,
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        await settle(page);
        // Short brief: three thumbnails, 5–8 theses; on a phone the first three and «Ещё».
        const theses = page.getByTestId("p-brief-theses").locator("li");
        const n = await theses.count();
        expect(n).toBeGreaterThanOrEqual(5);
        expect(n).toBeLessThanOrEqual(8);
        const visible = async () =>
          (await theses.evaluateAll((ls) => ls.filter((l) => (l as HTMLElement).offsetParent !== null)))
            .length;
        if (vp.width < 600) {
          expect(await visible()).toBe(3);
          await page.getByTestId("p-brief-theses-more").click();
        } else expect(await page.getByTestId("p-brief-theses-more").isVisible()).toBe(false);
        expect(await visible()).toBe(n);
        for (const k of ["journey", "dataRoles", "integrations"])
          expect(await page.getByTestId(`p-brief-thumb-${k}`).locator("rect").count()).toBeGreaterThan(1);
        await page
          .getByTestId("p-brief-summary")
          .screenshot({ path: join(ARTIFACTS, `brief-summary-${tag}.png`) });
        // Diagrams laid out for this width: the geometry is checked on the real glyphs.
        expect(await diagramProblems(page, '[data-testid^="demo-diagram-"]')).toEqual([]);
        await page
          .getByTestId("demo-diagram-journey")
          .screenshot({ path: join(ARTIFACTS, `brief-journey-${tag}.png`) });
        await page.screenshot({ path: join(ARTIFACTS, `brief-all-${tag}.png`), fullPage: true });
        expect(await a11y(page, "overflow")).toEqual([]);
        expect(await a11y(page, "labels")).toEqual([]);
        expect(await a11y(page, "contrast")).toEqual([]);
        if (vp.width === 390) expect(await a11y(page, "touch")).toEqual([]);
        await page.context().close();
      });

  for (const vp of SIZES)
    test(`${vp.width}px: panel — highlight, versions with the difference, diagrams, sessions; screenshots`, async () => {
      for (const scheme of ["light", "dark"] as const) {
        const tag = `${vp.width}-${scheme}`;
        const page = await demo.page({
          path: "brief/",
          query: `part=panel&theme=${scheme}`,
          viewport: vp,
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        await settle(page);
        const panel = page.getByTestId("p-brief-panel");
        expect(await page.getByTestId("p-brief-panel-version").textContent()).toContain("Версия 3");
        // The scenario added by version 3 is marked by a word.
        const marked = panel.locator('[data-changed="added"]');
        expect(await marked.count()).toBe(1);
        expect(await marked.textContent()).toContain("клиент оставляет отзыв после визита");
        expect(await marked.textContent()).toContain("новое");
        await panel.screenshot({ path: join(ARTIFACTS, `brief-panel-${tag}.png`) });
        expect(await a11y(page, "contrast")).toEqual([]);
        if (vp.width === 390) expect(await a11y(page, "touch")).toEqual([]);

        // Versions: the latest selected with its difference; an older one on a press.
        await page.getByTestId("p-brief-tab-versions").click();
        expect(await page.getByTestId("p-brief-version-3").getAttribute("aria-current")).toBe("true");
        expect(await page.getByTestId("p-brief-change").first().getAttribute("data-op")).toBe("added");
        await page.getByTestId("p-brief-version-2").click();
        const ops = await page
          .getByTestId("p-brief-change")
          .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-op")));
        expect(ops).toEqual(["changed", "added"]);
        expect(await page.getByTestId("p-brief-diff").locator("del").first().textContent()).toContain(
          "Не меньше 30 записей в месяц",
        );
        expect(await page.getByTestId("p-brief-diff").locator("ins").first().textContent()).toContain(
          "Не меньше 40 записей в месяц",
        );
        await panel.screenshot({ path: join(ARTIFACTS, `brief-versions-${tag}.png`) });
        expect(await a11y(page, "contrast")).toEqual([]);

        // Diagrams inside the panel (narrower than the page): the same geometry rules.
        await page.getByTestId("p-brief-tab-diagrams").click();
        expect(await diagramProblems(page, '[data-testid^="p-brief-diagram-"]')).toEqual([]);
        await panel.screenshot({ path: join(ARTIFACTS, `brief-diagrams-${tag}.png`) });

        // Sessions: interview, build, edits; a version of a session opens on «Версии».
        await page.getByTestId("p-brief-tab-sessions").click();
        const kinds = await page
          .getByTestId("p-session")
          .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-kind")));
        expect(kinds).toEqual(["edit", "edit", "build", "interview"]);
        await panel.screenshot({ path: join(ARTIFACTS, `brief-sessions-${tag}.png`) });
        await page.getByTestId("p-session-version-1").click();
        expect(await page.getByTestId("p-brief-version-1").getAttribute("aria-current")).toBe("true");

        // Keyboard: the arrows move between the tabs.
        await page.getByTestId("p-brief-tab-versions").focus();
        await page.keyboard.press("ArrowRight");
        expect(await page.getByTestId("p-brief-tab-sessions").getAttribute("aria-selected")).toBe("true");
        await page.keyboard.press("Home");
        expect(await page.getByTestId("p-brief-tab-brief").getAttribute("aria-selected")).toBe("true");
        await page.context().close();
      }
    });

  for (const vp of SIZES)
    test(`${vp.width}px: an edit in the panel goes to onSave with baseVersion and becomes version 4`, async () => {
      const page = await demo.page({
        path: "brief/",
        query: "part=panel&theme=light",
        viewport: vp,
        reducedMotion: "reduce",
      });
      await settle(page);
      await page.getByTestId("p-brief-edit-goals").click();
      const editor = page.getByTestId("p-brief-editor");
      await editor.getByLabel("Как поймём, что получилось").first().fill("Не меньше 60 записей в месяц");
      await page.getByTestId("p-brief-edit-section-outOfScope").click();
      await page.getByTestId("p-brief-add-outOfScope").click();
      await editor.getByLabel("Что не делаем сейчас").last().fill("Доставка лекарств");
      expect(await a11y(page, "labels")).toEqual([]);
      if (vp.width === 390) expect(await a11y(page, "touch")).toEqual([]);
      await editor.screenshot({ path: join(ARTIFACTS, `brief-editor-${vp.width}.png`) });
      await page.getByTestId("p-brief-save").click();
      const s = await saves(page);
      expect(s).toHaveLength(1);
      expect(s[0]?.baseVersion).toBe(3);
      expect(JSON.stringify(s[0]?.brief)).toContain("Не меньше 60 записей в месяц");
      expect(JSON.stringify(s[0]?.brief)).toContain("Доставка лекарств");
      // The new version closes the editor; the news says what changed.
      await expect.poll(() => page.getByTestId("p-brief-panel-version").textContent()).toContain("Версия 4");
      expect(await page.getByTestId("p-brief-editor").count()).toBe(0);
      expect(await page.getByTestId("p-brief-news").textContent()).toContain("В версии 4 — 2 изменения");
      expect(await page.locator('[data-changed="added"]').textContent()).toContain("Доставка лекарств");
      await page.context().close();
    });

  test("a thumbnail of the short brief opens the panel on that diagram", async () => {
    const page = await demo.page({
      path: "brief/",
      query: "part=summary&theme=light",
      reducedMotion: "reduce",
    });
    expect(await page.getByTestId("p-brief-panel").count()).toBe(0);
    await page.getByTestId("p-brief-thumb-integrations").click();
    expect(await page.getByTestId("p-brief-tab-diagrams").getAttribute("aria-selected")).toBe("true");
    await page.getByTestId("p-brief-diagram-integrations").waitFor();
    expect(await page.getByTestId("p-brief-diagram-integrations").textContent()).toContain("Ваша система");
    await page.context().close();
  });
});
