// V3-24 (build side): ui/seo.json goes into the bundle as is (client/assets/seo.json, SEO_ASSET) — the runtime reads
// it for /sitemap.xml and the head of every route, the entry sources of «Контент и блог» included; a system without
// the file has no such asset; a wrong file is still a build error (compose-v3-seo.test.ts).
import { describe, expect, test } from "vitest";
import { SEO_ASSET, SEO_PATH } from "../src/index.js";
import { build, forumFiles } from "./helpers.js";

const SEO = {
  version: 1,
  site: "Мастерская",
  pages: {
    "/": { title: "Мастерская — гончарная студия", description: "Занятия на круге." },
    "/blog": { title: "Блог — Мастерская", description: "Заметки мастерской." },
  },
  content: [
    {
      route: "/blog/:slug",
      entity: "article",
      slug: "slug",
      title: "title",
      description: ["seo_description", "excerpt"],
      seoTitle: "seo_title",
      image: "cover",
    },
  ],
};

describe("ui/seo.json in the bundle for the runtime", () => {
  test("the file goes into client/assets/seo.json as written, the entry sources included", async () => {
    const text = JSON.stringify(SEO, null, 2);
    const r = await build({ files: forumFiles().set(SEO_PATH, text) });
    expect(r.errors).toEqual([]);
    expect(SEO_ASSET).toBe("assets/seo.json");
    expect(new TextDecoder().decode(r.client.get(SEO_ASSET))).toBe(text);
    expect(JSON.parse(new TextDecoder().decode(r.client.get(SEO_ASSET))).content).toHaveLength(1);
  });

  test("a system without ui/seo.json has no SEO asset", async () => {
    const r = await build({ files: forumFiles() });
    expect(r.errors).toEqual([]);
    expect(r.client.has(SEO_ASSET)).toBe(false);
  });
});
