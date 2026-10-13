// V4-21 in Chromium: the promises of a scenario on a composed site of the clinic (DENTAL_BOOKING), opened by the critic's
// inspector with the draft's demo rows as the visitor sees them. The rehearsal's s1 promises doctors, reviews and
// contacts the site has no section for, and services whose demo names are stand-ins («Услуга 1»); a scenario that only
// promises what the site shows passes. The probe reads the sections of the pages as shown (names, texts, photos).
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { seedHintsFromBrief, withSitePages } from "@wizard/agents/builder";
import { afterAll, describe, expect, test } from "vitest";
import { briefSite } from "../../../packages/agents/test/v3-brief-site.js";
import { DENTAL_BOOKING } from "../../../packages/agents/test/v3-eval-briefs.js";
import { chromiumProvider } from "../src/agents/goal-browser.js";
import { draftDemoRows } from "../src/builds-v3/critic.js";
import { checkPromises, promiseRoutes, siteViews } from "../src/builds-v3/promises.js";

/** A scenario's `then` steps. */
const steps = (...then: string[]): { then: string[] } => ({ then });

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const browser = chromiumProvider({ slots: 1 });
afterAll(() => browser.close());

const S1 = steps("Пациент видит услуги с ценами «от», врачей с фото и опытом, отзывы, контакты, адрес");

describe.skipIf(!hasChromium)("V4-21 scenario promises in the browser", () => {
  test("s1 on the clinic's site: each promise not kept is said in words", async () => {
    const site = await briefSite("v4-21-dental", DENTAL_BOOKING);
    const spec = withSitePages(site.spec, site.site);
    const rows = draftDemoRows(spec, "v4-21-dental", seedHintsFromBrief(spec, site.ctx.brief));
    const input = { scenario: S1, spec, files: site.files };
    expect(promiseRoutes(S1, site.files)).toContain("/");
    const views = await siteViews(browser, input, { data: () => rows });
    expect(views).not.toBeNull();
    const home = views?.get("/") ?? [];
    // The probe saw the sections of the home page (its <main> children with an id) and the footer.
    expect(home.map((v) => v.id)).toEqual(expect.arrayContaining(["footer"]));
    expect(home.length).toBeGreaterThan(2);
    const r = checkPromises(S1, site.files, views);
    expect(r.browser).toBe(true);
    const all = r.problems.join("\n");
    expect(all).toContain("на сайте нет специалистов");
    expect(all).toContain("на сайте нет отзывов");
    expect(r.problems.every((p) => p.startsWith("Обещано в сценарии «Пациент видит услуги"))).toBe(true);
  }, 120_000);

  test("«Услуга 1» in the list of services is no list; the owner's names are", async () => {
    const site = await briefSite("v4-21-dental", DENTAL_BOOKING);
    const spec = withSitePages(site.spec, site.site);
    const scenario = steps("Пациент видит список услуг");
    // The draft's demo rows without the brief's names: a generator's «Услуга 1/2/3» (the rehearsal's catalog).
    const stand = draftDemoRows(spec, "v4-21-dental", []);
    expect((stand.service ?? []).map((r) => r.name)).toEqual(["Услуга 1", "Услуга 2", "Услуга 3"]);
    const r1 = checkPromises(
      scenario,
      site.files,
      await siteViews(browser, { scenario, spec, files: site.files }, { data: () => stand }),
    );
    expect(r1.problems).toEqual([
      "Обещано в сценарии «Пациент видит список услуг»: в списке услуг только заглушки вместо названий.",
    ]);
    const NAMES = ["Лечение кариеса", "Профессиональная чистка", "Имплантация"];
    const own = { ...stand, service: (stand.service ?? []).map((r, i) => ({ ...r, name: NAMES[i] })) };
    const views = await siteViews(browser, { scenario, spec, files: site.files }, { data: () => own });
    expect(views?.get("/")?.find((v) => v.id === "catalog")?.names).toEqual(NAMES);
    expect(checkPromises(scenario, site.files, views).problems).toEqual([]);
  }, 120_000);
});
