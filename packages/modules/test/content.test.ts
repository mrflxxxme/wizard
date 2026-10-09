// V3-24 «Контент и блог» (specs/modules/modules.yaml#catalog content): the backend recipe compiles in both fronts —
// articles with draft/published, slug, cover and SEO fields, rubrics, pages of the site by the parameters; a visitor
// reads only published entries (rowFilter of the public role), the owner writes, the staff write without deleting, a
// signed-in client of the visitor cabinet reads like a visitor; on the v2 front the module's pages, on the backend
// front its public screens and the useContent actions for the v3 composer (CONTENT_SCREENS), its goal scenarios on
// the public surface.
import type { Permission, SystemPlan } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  CATALOG,
  CONTENT_ROUTES,
  CONTENT_SCREENS,
  type CompileSuccess,
  compilePlan,
  contentManifest,
  matrixPlan,
} from "../src/index.js";

function compiled(plan: SystemPlan, front: "v2" | "backend" = "v2"): CompileSuccess {
  const r = compilePlan(plan, CATALOG, { appName: "Мастерская", front });
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}

const plan = (params: Record<string, unknown> = {}, withModules: string[] = []) =>
  matrixPlan(CATALOG, "content", { name: "проверка", params, withModules });

const perm = (r: CompileSuccess, role: string, entity: string): Permission | undefined =>
  r.spec.permissions.find((p) => p.role === role && p.entity === entity);

describe("entities and permissions", () => {
  test("articles, rubrics and pages: fields of the cabinet, unique slugs, the status draft by default", () => {
    const r = compiled(plan());
    const article = r.spec.entities.find((e) => e.name === "article");
    expect(article?.fields.map((f) => f.name)).toEqual([
      "title",
      "status",
      "published_at",
      "rubric",
      "slug",
      "excerpt",
      "body",
      "cover",
      "seo_title",
      "seo_description",
    ]);
    const field = (entity: string, name: string) =>
      r.spec.entities.find((e) => e.name === entity)?.fields.find((f) => f.name === name);
    expect(field("article", "status")).toMatchObject({ type: "enum", default: "draft", required: true });
    expect(field("article", "slug")).toMatchObject({ unique: true, required: true });
    expect(field("article", "cover")?.type).toBe("image");
    expect(field("article", "rubric")?.ref).toEqual({ entity: "rubric", onDelete: "set_null" });
    expect(field("article", "seo_description")?.maxLength).toBe(160);
    expect(field("rubric", "slug")).toMatchObject({ unique: true });
    expect(field("site_page", "body")?.type).toBe("text");
    // Public content: nothing personal in it (G2-PII), no retention.
    for (const e of r.spec.entities.filter((x) => ["article", "rubric", "site_page"].includes(x.name)))
      expect(
        e.fields.every((f) => !f.pii || f.pii === "none"),
        e.name,
      ).toBe(true);
  });

  test("a visitor reads published entries only; the owner writes and deletes; rubrics are public", () => {
    const r = compiled(plan());
    expect(perm(r, "guest", "article")).toEqual({
      role: "guest",
      entity: "article",
      ops: ["read"],
      rowFilter: { status: "published" },
    });
    expect(perm(r, "guest", "site_page")?.rowFilter).toEqual({ status: "published" });
    expect(perm(r, "guest", "rubric")).toEqual({ role: "guest", entity: "rubric", ops: ["read"] });
    for (const e of ["article", "rubric", "site_page"])
      expect(perm(r, "owner", e)?.ops, e).toEqual(["read", "create", "update", "delete"]);
  });

  test("the staff write without deleting; a client of the visitor cabinet reads like a visitor", () => {
    const staff = compiled(plan({}, ["staff"]));
    const roles = staff.spec.roles.filter((x) => x.name.startsWith("staff")).map((x) => x.name);
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) expect(perm(staff, role, "article")?.ops).toEqual(["read", "create", "update"]);
    // The section «Блог и страницы» of the staff module: only the roles with it write the content.
    const sections = plan({}, ["leads", "notify"]);
    sections.modules.push({
      id: "staff",
      params: { roles: ["Редактор", "Администратор"], sections_1: ["content"], sections_2: ["leads"] },
    });
    const scoped = compiled(sections);
    expect(perm(scoped, "staff", "article")?.ops).toEqual(["read", "create", "update"]);
    expect(perm(scoped, "staff_2", "article")).toBeUndefined();
    expect(
      scoped.spec.acceptance?.some(
        (a) => a.check?.role === "staff_2" && a.check.entity === "article" && a.check.expect === "deny",
      ),
    ).toBe(true);
    const withCabinet = plan({}, ["leads", "notify"]);
    withCabinet.modules.push({ id: "visitor_cabinet", params: { show_bookings: false, show_leads: true } });
    const visitor = compiled(withCabinet);
    const client = visitor.spec.roles.find((x) => x.selfSignup)?.name ?? "";
    expect(perm(visitor, client, "article")).toMatchObject({
      ops: ["read"],
      rowFilter: { status: "published" },
    });
  });

  test("parameters: without rubrics and pages there are only articles and their screens", () => {
    const r = compiled(plan({ with_rubrics: false, with_pages: false, blog_title: "Новости" }));
    expect(
      r.spec.entities.map((e) => e.name).filter((n) => ["article", "rubric", "site_page"].includes(n)),
    ).toEqual(["article"]);
    expect(r.spec.entities.find((e) => e.name === "article")?.fields.some((f) => f.name === "rubric")).toBe(
      false,
    );
    expect(
      r.spec.pages?.map((p) => p.route).filter((p) => p.startsWith("/blog") || p.startsWith("/pages")),
    ).toEqual(["/blog", "/blog/:slug"]);
    expect(r.files["ui/pages/ContentBlog.tsx"]).toContain('title="Новости"');
    expect(r.scenarios.map((s) => s.id)).toEqual(["GS-content-1", "GS-content-2", "GS-content-3"]);
  });
});

describe("fronts", () => {
  test("v2: the module's pages read by the slug of the address and render the body as React text", () => {
    const r = compiled(plan());
    expect(
      r.spec.pages?.filter((p) => p.file.startsWith("ui/pages/Content")).map((p) => [p.route, p.file]),
    ).toEqual([
      ["/blog", "ui/pages/ContentBlog.tsx"],
      ["/blog/:slug", "ui/pages/ContentArticle.tsx"],
      ["/blog/rubric/:slug", "ui/pages/ContentRubric.tsx"],
      ["/pages", "ui/pages/ContentPages.tsx"],
      ["/pages/:slug", "ui/pages/ContentSitePage.tsx"],
    ]);
    const lib = r.files["ui/content/lib.tsx"] ?? "";
    expect(lib).toContain("useParams");
    expect(lib).not.toContain("dangerouslySetInnerHTML");
    expect(r.files["ui/pages/ContentArticle.tsx"]).toContain('useBySlug("article", slug)');
    expect(r.files["ui/pages/ContentRubric.tsx"]).toContain("filter={{ rubric: row.id }}");
  });

  test("backend: no public pages; the screens and useContent actions of the v3 front, scenarios on the public surface", () => {
    const r = compiled(plan(), "backend");
    expect(r.spec.pages?.some((p) => p.route.startsWith("/blog") || p.route.startsWith("/pages"))).toBe(
      false,
    );
    expect(r.files["ui/content/lib.tsx"]).toBeUndefined();
    const screens = r.publicFront?.screens.filter((s) => s.module === "content") ?? [];
    expect(screens.map((s) => [s.id, s.route])).toEqual([
      ["blog", CONTENT_ROUTES.blog],
      ["article", CONTENT_ROUTES.article],
      ["rubric", CONTENT_ROUTES.rubric],
      ["pages", CONTENT_ROUTES.pages],
      ["site_page", CONTENT_ROUTES.page],
    ]);
    for (const s of screens) expect(CONTENT_SCREENS[s.id], s.id).toBeDefined();
    expect(
      r.publicFront?.actions.filter((a) => a.module === "content").map((a) => [a.entity, a.hook, a.ops]),
    ).toEqual([
      ["rubric", "useContent", ["read"]],
      ["article", "useContent", ["read"]],
      ["site_page", "useContent", ["read"]],
    ]);
    const surfaces = Object.fromEntries(
      r.scenarios
        .filter((s) => s.module === "content")
        .map((s) => [s.id, (s as { surface?: string }).surface]),
    );
    expect(surfaces).toEqual({
      "GS-content-1": "public",
      "GS-content-2": "public",
      "GS-content-3": "cabinet",
      "GS-content-4": "public",
      "GS-content-5": "public",
    });
  });

  test("the manifest: ready, the attract goal, the routes of its screens and a CI matrix", () => {
    expect(contentManifest.status).toBe("ready");
    expect(contentManifest.goals).toEqual(["attract"]);
    expect(contentManifest.provides?.routes).toEqual(Object.values(CONTENT_ROUTES));
    expect(contentManifest.tests?.matrix.length).toBeGreaterThanOrEqual(3);
  });
});
