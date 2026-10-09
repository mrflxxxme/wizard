// V3-24 regression of G1-RENDER-01 on v3 sites (G2-PII-04, compliance.yaml#system_package.consent.ui): a v3 site whose
// pages carry every variant of the lead form and of the booking form (form-* patterns over useLeadForm and useBooking)
// passes the server render's consent check — every form writing personal data has its consent in the DOM before
// sending: a block marked like the ui-kit ConsentCheckbox (data-testid wz-consent) with a checkbox and the link to
// the system's policy page. The check itself refuses a marker without a checkbox or without the policy link.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { type GateContext, runG0, runG1 } from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  composeSite,
  readSite,
  type SiteModel,
  siteFiles,
  withSitePages,
} from "../../agents/src/builder/v3/compose/index.js";
import { composeContext } from "../../agents/test/v3-compose-fixtures.js";
import { formsWithoutConsent, parseHtml } from "../../gates/src/g1/render/html.js";
import { PATTERNS } from "../../ui-kit/src/v3/patterns/index.js";
import { CATALOG, compilePlan } from "../src/index.js";

/** A same-origin photo of the system (the first-screen photo of the V3-12 fixtures). */
const PHOTO = {
  src: "/_wizard/photos/00000000-0000-4000-8000-000000000000/960",
  alt: "Светлый кабинет клиники с креслом у окна",
};

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;

beforeAll(async () => {
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_v324f_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-v324-forms-"));
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    env: {
      authModeDev: true,
      devLogin: false,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
}, 60_000);

afterAll(async () => {
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * The clinic of the V3-12 fixtures with the booking too, composed for v3; then one more page per form variant: the
 * lead form of the home page and the booking form of /booking in every variant of the library.
 */
function formsSite(): { spec: AppSpec; files: Map<string, string>; site: SiteModel; variants: string[] } {
  const base = composeContext({ systemId: "sys-v324-forms" });
  const plan = {
    ...base.plan,
    modules: [
      ...base.plan.modules.map((m) =>
        m.id === "catalog" ? { ...m, params: { ...m.params, with_duration: true } } : m,
      ),
      { id: "booking" },
    ],
  };
  const r = compilePlan(plan, CATALOG, { appName: "Белая линия", front: "backend" });
  if (!r.ok || !r.publicFront) throw new Error(JSON.stringify(r.ok ? "no front" : r.errors));
  const ctx = {
    ...base,
    plan: r.plan,
    spec: { ...r.spec, compliance: base.spec.compliance },
    publicFront: r.publicFront,
    files: new Map(Object.entries(r.files)),
  };
  const composed = composeSite(ctx);
  const site = composed.site;
  const home = site.pages.find((p) => p.route === "/");
  const booking = site.pages.find((p) => p.kind === "booking");
  const leadForm = home?.sections.find((s) => s.type === "form");
  const bookingForm = booking?.sections.find((s) => s.type === "form");
  if (!home || !booking || !leadForm || !bookingForm) throw new Error("no forms on the composed site");
  const variants: string[] = [];
  for (const p of PATTERNS.filter((x) => x.sectionType === "form")) {
    const from = p.needs === "booking" ? bookingForm : leadForm;
    const page = p.needs === "booking" ? booking : home;
    // The photo of the card variant: the owner's first-screen photo of the fixture.
    const props = p.slots.safeParse({ ...from.props, image: PHOTO });
    if (!props.success) throw new Error(`${p.id}: ${props.error.message}`);
    const route = `/forms/${p.variant}`;
    variants.push(p.id);
    site.pages.push({
      ...page,
      route,
      title: `Форма ${p.variant}`,
      file: `ui/pages/site/Form${p.variant.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())}.tsx`,
      component: `Form${p.variant.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())}`,
      header: false,
      sections: page.sections.map((s) =>
        s.type === "form" ? { ...s, pattern: p.id, props: props.data as Record<string, unknown> } : s,
      ),
    });
  }
  const files = new Map(ctx.files);
  for (const [path, v] of siteFiles(site, composed.facts.name, ctx.design, ctx.files)) {
    if (v === null) files.delete(path);
    else files.set(path, v);
  }
  return { spec: withSitePages(ctx.spec, readSite(files) as SiteModel), files, site, variants };
}

describe("G1-RENDER-01 on a v3 site: the consent of every lead and booking form", () => {
  test("every form variant of the library is on the site and the whole site passes G0 and G1", async () => {
    const { spec, files, variants } = formsSite();
    expect(variants.filter((v) => v.startsWith("form-booking")).length).toBeGreaterThanOrEqual(4);
    expect(variants.length).toBe(PATTERNS.filter((p) => p.sectionType === "form").length);
    const ctx: GateContext = {
      spec,
      prevSpec: null,
      specVersion: 1,
      files,
      env: "draft",
      systemKey: `v324f${randomBytes(3).toString("hex")}_${randomBytes(4).toString("hex")}`,
      db,
      milestone: "M1",
      runtime: rt,
      runtimeRole: role,
    };
    const blockers = (r: Awaited<ReturnType<typeof runG1>>) =>
      r.checks
        .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
        .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);
    expect(blockers(await runG0(ctx)), "G0").toEqual([]);
    const g1 = await runG1(ctx);
    expect(blockers(g1), "G1").toEqual([]);
    expect(g1.checks.find((c) => c.id === "G1-RENDER-01")?.status).toBe("pass");
  }, 300_000);

  test("the check: a marked consent with a checkbox and the policy link passes; a bare marker or no link does not", () => {
    const form = (consent: string) =>
      parseHtml(
        `<div><form><input name="name"><input name="phone">${consent}<button type="submit">Отправить</button></form></div>`,
      );
    const pii = new Set(["name", "phone"]);
    const ok =
      '<div data-testid="wz-consent"><input type="checkbox" id="c"><label for="c">Согласен <a href="/privacy" data-testid="wz-consent-policy-link">с политикой</a></label></div>';
    expect(formsWithoutConsent(form(ok), pii, "/privacy")).toEqual([]);
    expect(formsWithoutConsent(form(ok), pii, null)).toEqual([]);
    // A marker without a checkbox, a checkbox without the policy link, no consent at all.
    expect(formsWithoutConsent(form('<p data-testid="wz-consent">Согласие</p>'), pii, null)).toEqual([
      ["name", "phone"],
    ]);
    expect(
      formsWithoutConsent(
        form('<div data-testid="wz-consent"><input type="checkbox"></div>'),
        pii,
        "/privacy",
      ),
    ).toEqual([["name", "phone"]]);
    expect(formsWithoutConsent(form('<input type="checkbox">'), pii, null)).toEqual([["name", "phone"]]);
    // A form without personal fields needs none.
    expect(formsWithoutConsent(form(""), new Set(["comment"]), "/privacy")).toEqual([]);
  });
});
