// V3-18: the DOM contract of the modules' goal scenarios on the composed v3 site, without a model or a browser (the
// browser rung: apps/platform-api/test/v3-goals.browser.test.ts). The four eval briefs of checkpoint 1 composed the way
// the harness does it (plan of the brief, design of its direction, backend, skeleton): every first screen's main action
// leads to the form of its page, else to the form of the site; catalog items lead to the booking or the request form;
// the library sections the pages use carry the hooks the goal programs look for (Hero, LeadForm, BookingForm, item
// cards). siteRules keeps this after any edit (a model's page, the critic), and the critic cannot swap the showcase
// for a variant without the items' action.
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import { PATTERNS, patternById } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { applyEdit, type SiteModel, siteRules } from "../src/builder/index.js";
import { pageSource } from "../src/builder/v3/compose/index.js";
import type { SitePage, SiteSection } from "../src/builder/v3/compose/site.js";
import { briefSite } from "./v3-brief-site.js";
import { EVAL_BRIEFS } from "./v3-eval-briefs.js";

/** The site of a brief as the harness composes its skeleton (the seed of the system id, no model). */
const composed = briefSite;

const isForm = (s: SiteSection) => s.type === "form" && typeof s.props.entity === "string";
const href = (s: SiteSection | undefined) => (s?.props.action as { href?: string } | undefined)?.href;

describe("eval briefs without a model: the skeleton keeps the goal scenarios' DOM contract", () => {
  for (const [id, input] of Object.entries(EVAL_BRIEFS))
    test(id, async () => {
      const { files, site, front, spec } = await composed(id, input);
      expect(site.pages.length).toBeGreaterThan(0);
      const forms = site.pages.flatMap((p) => p.sections.filter(isForm).map((s) => ({ page: p, s })));
      expect(forms.length).toBeGreaterThan(0);
      const lead = forms.find((f) => f.s.props.booking === undefined);
      const booking = forms.find((f) => f.s.props.booking !== undefined);
      const main = booking && !lead ? booking : (lead ?? booking);
      for (const page of site.pages) {
        const hero = page.sections.find((s) => s.type === "hero");
        if (!hero) continue;
        const own = page.sections.find(isForm);
        // GS-landing-1: the main action of the first screen leads to the form of this page, else of the site.
        expect(href(hero), page.route).toBe(own ? `#${own.id}` : `${main?.page.route}#${main?.s.id}`);
      }
      // GS-catalog-4: every catalog item leads to its booking, else to the request form of the site.
      for (const page of site.pages)
        for (const s of page.sections.filter((x) => x.type === "catalog" && x.props.entity === "service"))
          expect(s.props.itemAction, page.route).toEqual(
            booking
              ? { label: "Записаться", path: booking.page.route }
              : { label: "Оставить заявку", path: `/#${lead?.s.id}` },
          );
      // The «sent» headings the goal scenarios read after a write (a booking the staff confirms is a request).
      const byRequest =
        spec.entities.find((e) => e.name === "booking")?.fields.find((x) => x.name === "status")?.default ===
        "new";
      for (const f of forms)
        expect((f.s.props.sent as { title: string }).title).toBe(
          f.s.props.booking === undefined
            ? "Заявка отправлена"
            : byRequest
              ? "Заявка на запись отправлена"
              : "Вы записаны",
        );
      // The library sections in the system carry the hooks: the page files import them from ui/patterns.
      const used = new Set(site.pages.flatMap((p) => p.sections.map((s) => s.pattern)));
      for (const pattern of used) {
        const meta = patternById(pattern);
        if (!meta) continue;
        const src = files.get(meta.file) ?? "";
        if (meta.sectionType === "hero")
          expect(src).toMatch(/data-wz-component="Hero"[\s\S]*data-testid="wz-hero-primary"/);
        if (meta.needs === "lead") expect(src).toContain('data-wz-component="LeadForm"');
        if (meta.needs === "booking")
          for (const hook of [
            "booking-page",
            "booking-service",
            "booking-day",
            "booking-slots",
            "booking-done",
          ])
            expect(src, `${pattern}: ${hook}`).toContain(hook);
        if (meta.needs === "catalog") expect(src).toContain('data-testid="wz-itemcard"');
        if (meta.needs === "catalog" && slotNames(meta.slots).includes("itemAction"))
          expect(src).toContain('data-testid="wz-itemcard-cta"');
      }
      // The public front has the actions the forms bind (a site of a CRM too: its request form).
      expect(front.actions.some((a) => a.hook === "useLeadForm" || a.hook === "useBooking")).toBe(true);
    });
});

/** Slot names of a pattern (its zod object schema). */
const slotNames = (slots: unknown) => Object.keys((slots as { shape?: Record<string, unknown> }).shape ?? {});

/** A page of a fixture site. */
function page(route: string, sections: SiteSection[]): SitePage {
  const component = route === "/" ? "Home" : route.slice(1).replace(/^./, (c) => c.toUpperCase());
  return {
    route,
    title: component,
    kind: route === "/" ? "home" : "catalog",
    file: `ui/pages/site/${component}.tsx`,
    component,
    nav: component,
    header: true,
    roles: ["guest"],
    seo: { title: component, description: component },
    sections,
  };
}

const hero = (to: string): SiteSection => ({
  id: "hero",
  type: "hero",
  pattern: "hero-centered",
  props: { title: "Студия", action: { label: "Обсудить проект", href: to } },
});
const leadForm = (sent = "Заявка отправлена"): SiteSection => ({
  id: "form",
  type: "form",
  pattern: "form-centered",
  props: { entity: "lead", title: "Заявка", submit: "Отправить заявку", sent: { title: sent } },
});
const catalog = (pattern: string, itemAction?: { label: string; path: string }): SiteSection => ({
  id: "catalog",
  type: "catalog",
  pattern,
  props: { entity: "service", title: "Услуги", ...(itemAction ? { itemAction } : {}) },
});
const model = (pages: SitePage[], primary: SiteModel["primary"] = null): SiteModel => ({
  version: 1,
  seed: "s",
  archetype: "editorial",
  primary,
  pages,
});

describe("siteRules: the site's actions after any edit", () => {
  test("the hero leads to its page's form, else to the form of the site; items to the request form", () => {
    const site = model([
      page("/", [hero("/services"), leadForm("Спасибо!")]),
      page("/services", [hero("tel:+79990000000"), catalog("catalog-list")]),
    ]);
    const out = siteRules(site);
    const [home, services] = out.pages;
    expect(href(home?.sections[0])).toBe("#form");
    expect(home?.sections[1]?.props.sent).toEqual({ title: "Заявка отправлена" });
    expect(href(services?.sections[0])).toBe("/#form");
    expect(services?.sections[1]?.props.itemAction).toEqual({ label: "Оставить заявку", path: "/#form" });
    // Idempotent; a site without module forms is left as it is.
    expect(siteRules(out)).toBe(out);
    const plain = model([page("/", [hero("tel:+79990000000")])]);
    expect(siteRules(plain)).toBe(plain);
  });

  test("a booking site: items to the booking page; a variant without item actions keeps none", () => {
    const booking: SiteSection = {
      id: "form",
      type: "form",
      pattern: "form-booking-grid",
      props: {
        entity: "booking",
        booking: {},
        title: "Запись",
        submit: "Записаться",
        sent: { title: "Готово" },
      },
    };
    const site = model(
      [
        page("/", [hero("#top")]),
        page("/services", [hero("/"), catalog("catalog-grid", { label: "Выбрать", path: "/x" })]),
        page("/prices", [hero("/"), catalog("catalog-price-list")]),
        page("/booking", [hero("/"), booking]),
      ],
      { kind: "booking", label: "Записаться", route: "/booking", anchor: "form" },
    );
    const out = siteRules(site);
    expect(out.pages.map((p) => href(p.sections[0]))).toEqual([
      "/booking#form",
      "/booking#form",
      "/booking#form",
      "#form",
    ]);
    expect(out.pages[1]?.sections[1]?.props.itemAction).toEqual({ label: "Выбрать", path: "/booking" });
    expect(out.pages[2]?.sections[1]?.props.itemAction).toBeUndefined();
    expect(out.pages[3]?.sections[1]?.props.sent).toEqual({ title: "Вы записаны" });
  });

  test("the page file opens at the anchor of its address (the app renders after the load)", () => {
    const src = pageSource(page("/", [hero("#form"), leadForm()]));
    expect(src).toContain('import { useEffect } from "react";');
    expect(src).toContain("document.getElementById(id)?.scrollIntoView()");
    expect(src).toContain('<div id="form">');
  });

  test("the critic cannot swap the showcase for a variant that drops the items' action", () => {
    const site = model([
      page("/", [hero("#form"), leadForm()]),
      page("/services", [
        hero("/#form"),
        catalog("catalog-list", { label: "Оставить заявку", path: "/#form" }),
      ]),
    ]);
    const design = designSystemV3({ archetype: "editorial", seed: "s", niche: "интерьеры" });
    const env = { library: PATTERNS, numbers: new Set<string>() };
    const swap = (pattern: string) =>
      applyEdit(
        { site, design },
        { op: "swap_variant", route: "/services", section: "catalog", pattern },
        env,
      );
    expect(swap("catalog-price-list")).toMatchObject({ ok: false });
    expect(swap("catalog-grid")).toMatchObject({ ok: true });
  });
});
