// V3-12: the page composer's skeleton (builder-v3.md C6 «skeleton», D77 (10)) — every public page of the system from
// library patterns and the design system, texts from the brief and the plan, without a model; multi-page navigation and
// SEO on every page (acceptance 3); the composed system passes G0 with the v3 allowances (react, motion/react, the
// headless hooks in ui/pages|patterns|sections only) while v2 systems keep the old rules.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { checkFile, runG0, runG2 } from "@wizard/gates";
import { compilePlan } from "@wizard/modules";
import { toRoleSpec } from "@wizard/ui-kit";
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { buildRenderBundle } from "../../gates/src/g1/render/bundle.js";
import { RenderProcess } from "../../gates/src/g1/render/host.js";
import { allModulesPlan } from "../../modules/test/fixtures.js";
import {
  createPageComposer,
  DESIGN_CSS,
  lintErrors,
  lintSitePage,
  readSite,
  SEO_JSON,
  type SiteModel,
  siteFacts,
  withSitePages,
} from "../src/builder/v3/compose/index.js";
import type { V3BuildContext, V3ComposeResult } from "../src/builder/v3/contract.js";
import { DEFAULT_REGISTRY } from "../src/planner/index.js";
import { composeContext } from "./v3-compose-fixtures.js";

function apply(files: ReadonlyMap<string, string>, out: V3ComposeResult): Map<string, string> {
  const next = new Map(files);
  for (const [p, v] of out.files) {
    if (v === null) next.delete(p);
    else next.set(p, v);
  }
  return next;
}

async function skeleton(ctx: V3BuildContext, patterns = PATTERNS) {
  const out = await createPageComposer({ patterns }).skeleton(ctx);
  const files = apply(ctx.files, out);
  const site = readSite(files) as SiteModel;
  return { out, files, site, spec: withSitePages(ctx.spec, site) };
}

const G0_CODE = ["G0-IMP-01", "G0-SEC-01", "G0-TS-01", "G0-BUILD-01", "G0-SPEC-03", "G0-SPEC-04"];
const failing = (checks: { status: string }[]) =>
  checks.filter((c) => c.status === "fail" || c.status === "error");

describe("skeleton: pages, sections, texts", () => {
  test("no model calls, deterministic; every public page of the front, the home page first", async () => {
    const ctx = composeContext();
    const a = await skeleton(ctx);
    const b = await skeleton(composeContext());
    expect(a.out.spentRub).toBe(0);
    expect([...a.out.files]).toEqual([...b.out.files]);
    expect(a.out.pages.map((p) => p.route)).toEqual(["/", "/services", "/photos"]);
    expect(a.out.pages.map((p) => p.title)).toEqual(["Главная", "Каталог и цены", "Источники фото"]);
    expect(a.out.notes[0]).toMatch(/^Собрал каркас сайта в стиле «.+»: 3 стр\./);
    // Every section type of the pages has library patterns now; sections whose required content the facts do not give
    // (FAQ needs two answers — the plan has one) are left out, never invented.
    expect(a.out.notes.join("\n")).not.toContain("нет подходящего паттерна");
    for (const p of a.site.pages) expect(p.sections.some((s) => s.type === "faq")).toBe(false);
    // V3-18: the contacts the owner gave (phone, address) on home — without hours or a map of our own.
    const contacts = a.site.pages[0]?.sections.find((s) => s.type === "contacts")?.props;
    expect(contacts).toMatchObject({
      title: "Контакты",
      address: { text: "Казань, ул. Баумана, 15" },
      phones: [{ number: "+7 843 200-40-50", href: "tel:+78432004050" }],
    });
    expect(contacts?.hours).toBeUndefined();
    expect(contacts?.map).toBeUndefined();
  });

  test("sections bound to the modules (V3-08 patterns with needs): the lead form and the catalog showcase", async () => {
    const { site } = await skeleton(composeContext());
    const meta = (id?: string) => PATTERNS.find((p) => p.id === id);
    const form = site.pages[0]?.sections.find((s) => s.id === "form");
    expect(meta(form?.pattern)?.needs).toBe("lead");
    expect(form?.props).toMatchObject({
      entity: "lead",
      title: "Оставьте заявку",
      text: "Перезвоним и подберём время",
      // «Отправить» of the plan says nothing (K09): the button names the action.
      submit: "Отправить заявку",
      sent: { title: "Заявка отправлена" },
    });
    const catalog = site.pages[1]?.sections.find((s) => s.id === "catalog");
    expect(meta(catalog?.pattern)?.needs).toBe("catalog");
    expect(catalog?.props).toMatchObject({ entity: "service", title: "Услуги и цены" });
    // The services section of the home page in the services slot contract (≥ 2 items of the plan).
    const services = site.pages[0]?.sections.find((s) => s.id === "services");
    expect(meta(services?.pattern)?.sectionType).toBe("services");
    expect((services?.props.items as unknown[] | undefined)?.length).toBeGreaterThanOrEqual(2);
  });

  test("files: the design system, the patterns used, one page per route importing them, SEO and the site model", async () => {
    const ctx = composeContext();
    const { out, files, site, spec } = await skeleton(ctx);
    expect(out.files.get(DESIGN_CSS)).toContain("@theme inline");
    expect(out.files.get(DESIGN_CSS)).toContain("@font-face");
    const used = [...new Set(site.pages.flatMap((p) => p.sections.map((s) => s.pattern)))].sort();
    expect([...out.files.keys()].filter((p) => p.startsWith("ui/patterns/")).sort()).toEqual(
      used.map((id) => `ui/patterns/${id}.tsx`),
    );
    for (const id of used)
      expect(files.get(`ui/patterns/${id}.tsx`)).toBe(PATTERNS.find((p) => p.id === id)?.source);
    for (const page of site.pages) {
      const src = files.get(page.file) as string;
      for (const s of page.sections) expect(src).toContain(`from "../../patterns/${s.pattern}"`);
      expect(spec.pages?.find((p) => p.route === page.route)).toMatchObject({
        file: page.file,
        title: page.title,
      });
    }
    // The cabinets of the modules stay; the public pages get every role of their screen.
    expect(spec.pages?.map((p) => p.route)).toEqual(
      expect.arrayContaining(["/cabinet", "/cabinet/notifications", "/", "/services", "/photos"]),
    );
    expect(JSON.parse(out.files.get(SEO_JSON) as string).pages["/services"]).toEqual({
      title: "Каталог и цены — Белая линия",
      description: "Каталог и цены. Белая линия — стоматологическая клиника.",
    });
  });

  test("one header and one footer for the whole site; variety of variants and layout families", async () => {
    const { site } = await skeleton(composeContext());
    const header = new Set(site.pages.map((p) => p.sections[0]?.pattern));
    const footer = new Set(site.pages.map((p) => p.sections.at(-1)?.pattern));
    expect(header.size).toBe(1);
    expect(footer.size).toBe(1);
    expect([...header][0]).toMatch(/^header-/);
    expect([...footer][0]).toMatch(/^footer-/);
    const heroes = site.pages.map((p) => p.sections.find((s) => s.type === "hero")?.pattern);
    expect(new Set(heroes).size).toBe(heroes.length);
    for (const page of site.pages) {
      const layouts = page.sections
        .filter((s) => s.type !== "header" && s.type !== "footer")
        .map((s) => PATTERNS.find((p) => p.id === s.pattern)?.layout);
      for (let i = 1; i < layouts.length; i++) expect(layouts[i]).not.toBe(layouts[i - 1]);
    }
  });

  test("navigation: the header lists the pages, the footer every page (photo credits too); the action leads to the form", async () => {
    const { site } = await skeleton(composeContext());
    const home = site.pages[0];
    const services = site.pages[1];
    if (!home || !services) throw new Error("pages");
    const nav = (p: typeof home) => p.sections[0]?.props.nav;
    expect(nav(home)).toEqual([
      { label: "Главная", href: "/" },
      { label: "Каталог и цены", href: "/services" },
    ]);
    const footer = home.sections.at(-1)?.props as { columns?: { links: { href: string }[] }[] };
    expect(footer.columns?.[0]?.links.map((l) => l.href)).toEqual(["/", "/services", "/photos"]);
    // The lead form is bound to the leads module's entity through the headless hook (C4).
    expect(home.sections.find((s) => s.id === "form")).toMatchObject({
      pattern: expect.stringMatching(/^form-/),
      props: { entity: "lead" },
    });
    expect(home.sections.find((s) => s.type === "hero")?.props.action).toEqual({
      label: "Оставить заявку",
      href: "#form",
    });
    expect(services.sections.find((s) => s.type === "hero")?.props.action).toEqual({
      label: "Оставить заявку",
      href: "/#form",
    });
  });

  test("texts only from the facts: the plan's texts, no examples, no invented numbers; every page passes the linter", async () => {
    const ctx = composeContext();
    const { site, files } = await skeleton(ctx);
    const text = JSON.stringify(site);
    expect(text).toContain("Лечим зубы без боли и очередей");
    expect(text).not.toContain("Пример");
    expect(text).not.toContain("ООО «Улыбка»");
    expect(text).toContain("ООО «Белая линия»");
    const facts = siteFacts(ctx);
    for (const page of site.pages) expect(lintErrors(lintSitePage(site, page, facts, PATTERNS))).toEqual([]);
    // One h1 per page — the first screen.
    for (const page of site.pages) expect((files.get(page.file) ?? "").match(/<Hero/g)).toHaveLength(1);
  });

  test("SEO on every page: title, description; og:image from the first screen photo", async () => {
    const { site } = await skeleton(composeContext());
    for (const p of site.pages) {
      expect(p.seo.title.length).toBeGreaterThan(5);
      expect(p.seo.title.length).toBeLessThanOrEqual(70);
      expect(p.seo.description.length).toBeLessThanOrEqual(160);
    }
    expect(site.pages[0]?.seo.image).toMatch(/^\/_wizard\/photos\/[0-9a-f-]+\/1600$/);
    const bare = await skeleton(composeContext({ photos: false }));
    expect(bare.site.pages[0]?.seo.image).toBeUndefined();
    const hero = bare.site.pages[0]?.sections.find((s) => s.type === "hero");
    expect(hero?.props.image).toBeUndefined();
    expect(hero?.props.images).toBeUndefined();
  });

  test("missing facts: an honest neutral wording, never an invented one", async () => {
    const ctx = composeContext();
    const spec: AppSpec = {
      ...ctx.spec,
      compliance: { consentTemplateId: "default", policyPage: "/privacy" },
    };
    const plan = { ...ctx.plan };
    delete plan.landing;
    const { site } = await skeleton({ ...ctx, spec, plan });
    const footer = site.pages[0]?.sections.at(-1)?.props as { legal: { operator: string } };
    // V3-18: no placeholder of the operator before the owner gives one — the year and the site's name.
    expect(footer.legal.operator).toBe(`© ${new Date().getUTCFullYear()} Белая линия`);
    const hero = site.pages[0]?.sections.find((s) => s.type === "hero")?.props;
    expect(hero?.title).toBe("Белая линия — стоматологическая клиника");
    expect(JSON.stringify(site)).not.toMatch(/довольн|лучш|гарант|отзыв/i);
  });

  test("a re-run drops the composer's files the new composition does not use, and only those", async () => {
    const ctx = composeContext();
    const first = await skeleton(ctx);
    const old = "export default function X() {\n  return null;\n}\n";
    const stale = new Map(first.files)
      .set("ui/patterns/zz-old.tsx", old)
      .set("ui/sections/old-signature.tsx", old)
      .set("ui/pages/site/Old.tsx", old);
    const again = await createPageComposer({ patterns: PATTERNS }).skeleton({ ...ctx, files: stale });
    for (const p of ["ui/patterns/zz-old.tsx", "ui/sections/old-signature.tsx", "ui/pages/site/Old.tsx"])
      expect(again.files.get(p)).toBeNull();
    // Cabinets of the modules are not the composer's.
    expect(again.files.has("ui/pages/Cabinet.tsx")).toBe(false);
    expect(first.files.has("ui/pages/Cabinet.tsx")).toBe(true);
  });

  test("a system without public screens and actions (CRM) gets no site", async () => {
    const ctx = composeContext();
    const out = await createPageComposer().skeleton({
      ...ctx,
      publicFront: { screens: [], actions: [], functions: [] },
    });
    expect(out.pages).toEqual([]);
    expect(out.files.size).toBe(0);
    expect(out.notes[0]).toContain("Публичных страниц в системе нет");
  });

  test("a library without form patterns: the form is left out, the action goes to the catalog", async () => {
    const { site } = await skeleton(
      composeContext(),
      PATTERNS.filter((p) => p.sectionType !== "form"),
    );
    expect(site.pages[0]?.sections.some((s) => s.id === "form")).toBe(false);
    expect(site.primary).toMatchObject({ kind: "catalog", route: "/services" });
    // The plan's call to action was written for the form: not reused for the catalog link.
    expect(JSON.stringify(site)).not.toContain("Спросить");
  });
});

describe("V3-18: photo credits, inner first screens, the footer", () => {
  const props = (site: SiteModel, route: string, type: string) =>
    site.pages.find((p) => p.route === route)?.sections.find((s) => s.type === type)?.props;

  test("«Источники фото» only on a site with stock photos, and it names their authors and stocks", async () => {
    const bare = await skeleton(composeContext({ photos: false }));
    expect(bare.site.pages.map((p) => p.route)).toEqual(["/", "/services"]);
    const footer = props(bare.site, "/", "footer") as { columns: { links: { href: string }[] }[] };
    expect(footer.columns.flatMap((c) => c.links.map((l) => l.href))).not.toContain("/photos");
    const { site } = await skeleton(composeContext());
    const credits = props(site, "/photos", "hero");
    expect(credits?.lead).toBe(
      "Фотографии на сайте — со стоков, по их бесплатным лицензиям. Авторы: Автор, Pexels.",
    );
  });

  test("an inner page's first screen says what the page holds, not only its title and a button", async () => {
    const { site } = await skeleton(composeContext());
    const services = props(site, "/services", "hero");
    expect(services?.title).toBe("Каталог и цены");
    expect(typeof services?.lead).toBe("string");
    expect(String(services?.lead ?? "").length).toBeGreaterThan(10);
  });

  test("the footer: «© <year>» with the operator, both the phone and the e-mail the owner gave", async () => {
    const ctx = composeContext();
    const spec: AppSpec = {
      ...ctx.spec,
      compliance: { ...ctx.spec.compliance, operatorContact: "+7 843 200-40-50, info@belaya-liniya.ru" },
    };
    const { site } = await skeleton({ ...ctx, spec });
    const year = new Date().getUTCFullYear();
    const footer = props(site, "/", "footer") as {
      legal: { operator: string };
      contacts: { label: string; value: string; href?: string }[];
    };
    expect(footer.legal.operator).toBe(`© ${year} ООО «Белая линия»`);
    expect(footer.contacts.map((c) => [c.label, c.href])).toEqual([
      ["Телефон", "tel:+78432004050"],
      ["Почта", "mailto:info@belaya-liniya.ru"],
      ["Адрес", undefined],
    ]);
    expect(siteFacts({ ...ctx, spec })).toMatchObject({
      phone: "+7 843 200-40-50",
      email: "info@belaya-liniya.ru",
    });
    for (const page of site.pages)
      expect(lintErrors(lintSitePage(site, page, siteFacts({ ...ctx, spec }), PATTERNS)), page.route).toEqual(
        [],
      );
  });
});

describe("gates on the composed system (v3 allowances)", () => {
  test("G0 imports, forbidden API, types, build, files and orphans pass (draft and the published bundle)", async () => {
    const ctx = composeContext();
    const { files, spec } = await skeleton(ctx);
    const g0 = (env: "draft" | "prod") =>
      runG0(
        { spec, prevSpec: null, specVersion: 0, files, env, systemKey: "v3_compose", db: undefined as never },
        { only: G0_CODE },
      );
    // Every check passes outright in both builds: no soft note either (G0-BUILD-01 warns over 1 MB of interface; the
    // patterns animate through LazyMotion + domAnimation, so the draft site with forms and the catalog stays under it).
    for (const env of ["draft", "prod"] as const) {
      const report = await g0(env);
      expect(failing(report.checks), env).toEqual([]);
      expect(
        report.checks.filter((c) => G0_CODE.includes(c.id) && c.status !== "pass"),
        env,
      ).toEqual([]);
    }
  }, 120_000);

  test("V3-18: a system id ending in 8+ digits does not read as a Telegram token in ui/site.json (G2-SECRET-01)", async () => {
    // The platform seeds the design with the system id, so the site model's seed is `<uuid>:<uuid>`; this id once
    // failed the techreview at random (CI on a23b263): «…735f83595416:566a…» matched `\d{8,10}:[A-Za-z0-9_-]{35}`.
    const id = "566a07ec-2235-4082-85c6-735f83595416";
    const base = composeContext({ systemId: id });
    const ctx = {
      ...base,
      design: designSystemV3({ archetype: base.design.archetype, seed: id, niche: base.plan.niche }),
    };
    const { files, spec } = await skeleton(ctx);
    expect(files.get("ui/site.json")).toContain(`"seed": "${id}:${id}"`);
    const report = await runG2(
      {
        spec,
        prevSpec: null,
        specVersion: 0,
        files,
        env: "draft",
        systemKey: "v3_compose",
        db: undefined as never,
      },
      { only: ["G2-SECRET-01"] },
    );
    expect(report.checks.find((c) => c.id === "G2-SECRET-01")?.status).toBe("pass");
  });

  test("v2 systems keep the old rules; in v3 only the public page files get react, motion and the headless hooks", async () => {
    const pattern =
      'import { useState } from "react";\nexport default function X() { useState(0); return null; }\n';
    const imp = (path: string, v3: boolean) =>
      checkFile(path, pattern, undefined, { v3 }).filter((c) => c.id === "G0-IMP-01" && c.status === "fail");
    expect(imp("ui/patterns/x.tsx", true)).toEqual([]);
    expect(imp("ui/sections/x.tsx", true)).toEqual([]);
    expect(imp("ui/pages/site/X.tsx", true)).toEqual([]);
    expect(imp("ui/patterns/x.tsx", false)).toHaveLength(1);
    expect(imp("ui/lib/x.tsx", true)).toHaveLength(1);
    const other = 'import { z } from "zod";\nexport default function X() { return null; }\n';
    expect(
      checkFile("ui/patterns/x.tsx", other, undefined, { v3: true }).filter(
        (c) => c.id === "G0-IMP-01" && c.status === "fail",
      ),
    ).toHaveLength(1);
    // A v2 system with the same file: the whole G0 run refuses it.
    const r = compilePlan(allModulesPlan(), DEFAULT_REGISTRY, { appName: "Проверка" });
    if (!r.ok) throw new Error("plan");
    const files = new Map(Object.entries(r.files)).set("ui/patterns/x.tsx", pattern);
    const report = await runG0(
      {
        spec: r.spec,
        prevSpec: null,
        specVersion: 0,
        files,
        env: "draft",
        systemKey: "v2_x",
        db: undefined as never,
      },
      { only: ["G0-IMP-01"] },
    );
    expect(failing(report.checks).map((c) => (c as { evidence?: string }).evidence)).toEqual(["react"]);
  }, 60_000);

  test("G1 render: the v3 pages bundle with React and Motion and render on the server; v2 keeps refusing them", async () => {
    const ctx = composeContext();
    const { files, spec, site } = await skeleton(ctx);
    const bundle = await buildRenderBundle(spec, files);
    expect(bundle.errors).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "wz-render-v3-"));
    writeFileSync(join(dir, "render.js"), bundle.code);
    const proc = new RenderProcess(dir, async () => ({
      status: 404,
      body: JSON.stringify({ error: { code: "NOT_FOUND", message: "нет" } }),
    }));
    try {
      for (const page of site.pages) {
        const out = await proc.render(
          {
            file: page.file,
            path: page.route,
            routes: site.pages.map((p) => p.route),
            roleSpec: toRoleSpec(spec),
          },
          10_000,
        );
        expect(out.kind, page.route).toBe("done");
        if (out.kind !== "done") continue;
        expect(out.ok, `${page.route}: ${out.error}`).toBe(true);
        expect(out.html?.match(/<h1/g), page.route).toHaveLength(1);
        expect(out.html).toContain(page.route === "/" ? "Лечим зубы без боли и очередей" : page.title);
      }
    } finally {
      await proc.kill();
    }
    // The same pattern in a v2 system (no ui/design.css), or outside the page folders of a v3 one: refused.
    const v2 = new Map([...files].filter(([p]) => p !== "ui/design.css"));
    expect((await buildRenderBundle(spec, v2)).errors.join("\n")).toContain("Импорт «react» запрещён");
    const lib = new Map(files).set("ui/lib/x.tsx", 'export { useState } from "react";\n');
    const home = site.pages[0]?.file as string;
    lib.set(home, `import "../../lib/x";\n${files.get(home)}`);
    expect((await buildRenderBundle(spec, lib)).errors.join("\n")).toContain("Импорт «react» запрещён");
  }, 60_000);

  test("G0-TS-01 types the v3 pages: a wrong prop of a pattern is a type error of the page", async () => {
    const ctx = composeContext();
    const { files, spec, site } = await skeleton(ctx);
    const home = site.pages[0]?.file as string;
    const broken = new Map(files).set(home, (files.get(home) as string).replace('"title":', '"titel":'));
    const report = await runG0(
      {
        spec,
        prevSpec: null,
        specVersion: 0,
        files: broken,
        env: "draft",
        systemKey: "v3_ts",
        db: undefined as never,
      },
      { only: ["G0-TS-01"] },
    );
    expect(failing(report.checks).map((c) => (c as { file?: string }).file)).toContain(home);
  }, 120_000);
});
