// V5-01: the block library v4 — catalog shape, slots against examples, static first render, tokens only, AA pairs.
import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { contrast } from "../src/tokens/color.js";
import { PATTERN_COLOR_ROLES } from "../src/v3/design/css.js";
import { ARCHETYPES, designSystemV3 } from "../src/v3/design/index.js";
import { schemeHex } from "../src/v3/design/palette.js";
import { BLOCK_KINDS, BLOCKS } from "../src/v4/blocks/index.js";

const DIR = new URL("../src/v4/blocks/", import.meta.url);
const sourceOf = (id: string) => {
  const [kind, ...rest] = id.split("-");
  return readFileSync(new URL(`${kind}/${rest.join("-")}.tsx`, DIR), "utf8");
};

describe("block catalog", () => {
  test("ids are unique, match their file and kind, and every file is in the catalog", () => {
    const ids = BLOCKS.map((b) => b.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BLOCKS) {
      expect(BLOCK_KINDS).toContain(b.meta.kind);
      expect(b.meta.id.startsWith(`${b.meta.kind}-`)).toBe(true);
    }
    const files = BLOCK_KINDS.flatMap((k) => {
      try {
        return readdirSync(new URL(`${k}/`, DIR)).map((f) => `${k}-${f.replace(/\.tsx$/, "")}`);
      } catch {
        return [];
      }
    });
    expect(files.sort()).toEqual([...ids].sort());
  });

  test("at least three hero modules, one of them the heavy effect", () => {
    const heroes = BLOCKS.filter((b) => b.meta.kind === "hero");
    expect(heroes.length).toBeGreaterThanOrEqual(3);
    expect(heroes.some((b) => b.meta.effect === "heavy")).toBe(true);
  });

  for (const { meta } of BLOCKS)
    test(`${meta.id}: example fits the slots, variants match the variant slot, texts in Russian`, () => {
      expect(meta.slots.safeParse(meta.example).error?.issues ?? []).toEqual([]);
      expect(meta.variants.length).toBeGreaterThan(0);
      const shape = (
        meta.slots as unknown as { shape?: Record<string, { unwrap?: () => { options?: string[] } }> }
      ).shape;
      const opts = shape?.variant?.unwrap?.().options;
      if (opts) expect(meta.variants.map((v) => v.id)).toEqual(opts);
      expect(meta.title).toMatch(/[а-яё]/i);
      expect(meta.description.length).toBeGreaterThan(40);
    });
});

describe("block render", () => {
  for (const { meta, Component } of BLOCKS)
    test(`${meta.id}: server render is the static frame with a canvas mark`, () => {
      const html = renderToStaticMarkup(createElement(Component as never, { ...meta.example, wzId: "s1" }));
      expect(html).toContain('data-wz-id="s1"');
      expect(html).toMatch(/data-wz-component="[A-Z]\w+"/);
      // Static first frame: no inline transforms of an entrance and no running shader before hydration.
      expect(html).not.toMatch(/opacity:\s*0[;"]/);
    });
});

describe("tokens only", () => {
  const RAW = [
    /#[0-9a-f]{3,8}\b(?![^"]*\bid=)/i,
    /\b(?:bg|text|border|from|to|via|ring|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/,
    /\brgba?\(|\bhsla?\(/,
  ];
  for (const { meta } of BLOCKS)
    test(`${meta.id}: no raw colours or palette utilities, no 21st.dev code`, () => {
      const src = sourceOf(meta.id).replace(/data:image\/svg\+xml[^"]+/g, "");
      for (const re of RAW) expect(src).not.toMatch(re);
      expect(src).not.toMatch(/21st\.dev|@21st/);
    });
});

describe("contrast AA of the token pairs the blocks set text on", () => {
  // [text, background, minimum]: running text 4.5:1; muted text sits on page, card and muted surfaces.
  const PAIRS: [string, string, number][] = [
    ["foreground", "background", 4.5],
    ["muted-foreground", "background", 4.5],
    ["muted-foreground", "card", 4.5],
    ["card-foreground", "card", 4.5],
    ["primary-foreground", "primary", 4.5],
    ["inverse-foreground", "inverse", 4.5],
    ["foreground", "muted", 4.5],
    // Icons and large figures in the primary colour: non-text contrast 3:1.
    ["primary", "background", 3],
  ];
  for (const a of ARCHETYPES)
    test(a.id, () => {
      for (const seed of [1, 2, 3]) {
        const ds = designSystemV3({ archetype: a.id, brandColor: "#2F6B4F", seed, niche: "Студия света" });
        for (const scheme of ["light", "dark"] as const) {
          const hex = schemeHex(ds.palette[scheme]);
          for (const [fg, bg, min] of PAIRS) {
            const fgRole = PATTERN_COLOR_ROLES[fg];
            const bgRole = PATTERN_COLOR_ROLES[bg];
            if (!fgRole || !bgRole) throw new Error(`${fg}/${bg}`);
            const ratio = contrast(hex[fgRole], hex[bgRole]);
            expect(ratio, `${a.id} ${scheme} seed ${seed}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
          }
        }
      }
    });
});
