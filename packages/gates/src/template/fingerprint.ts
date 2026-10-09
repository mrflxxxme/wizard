// Fingerprint of a public v3 site for the template gate (V3-14, D77_v3 (6)): per page the section sequence of the
// composer's site model (ui/site.json: section type, layout family and variant of the library pattern), a DOM shape
// sketch of every rendered section (computed in the browser) and perceptual hashes of the first screen and of the
// full page at 390 and 1440 px. No texts and no images are kept — only structure, numbers and 64-bit hashes.

/** Viewports of the gate: the phone and the wide desktop (the critic's 768 adds little to the composition). */
export const TEMPLATE_VIEWPORTS = [
  { id: "390", width: 390, height: 844 },
  { id: "1440", width: 1440, height: 900 },
] as const;
export type TemplateViewportId = (typeof TEMPLATE_VIEWPORTS)[number]["id"];

/** The full-page screenshot is cut at this height (px): the hash squeezes it to 32×32 anyway. */
export const FULL_PAGE_MAX_HEIGHT = 12_000;

/** A section of the site model as a structural token. */
export interface SectionToken {
  /** Section type (hero, services…) or «signature» for a section written as free code. */
  type: string;
  /** Layout family of the pattern (ui-kit LAYOUT_FAMILIES), «signature», or «» when unknown. */
  layout: string;
  /** Variant of the pattern («» for a signature section). */
  variant: string;
}

/** The shape of one rendered section (DOM_SKETCH_SCRIPT), numbers only. */
export interface SectionShape {
  /** Height ÷ viewport width, one decimal. */
  h: number;
  /** Depth of the visible DOM subtree (capped at 24). */
  depth: number;
  /** Most boxes side by side in one row (grid or flex columns; 1 — a single column). */
  cols: number;
  /** Images, videos, canvases and large SVGs (≥ 2 % of the viewport width squared). */
  media: number;
  /** Text blocks (headings, paragraphs, list items, quotes, labels, table cells). */
  text: number;
  /** Links, buttons and form fields. */
  controls: number;
  /** 1 — the first heading is centred in the section. */
  center: 0 | 1;
}

/** Perceptual hashes of one screenshot (16 hex digits each). */
export interface ImageHashes {
  p: string;
  d: string;
}

/** A page rendered at one viewport. */
export interface PageView {
  shapes: SectionShape[];
  /** The first screen (viewport-sized screenshot). */
  first: ImageHashes;
  /** The full page (cut at FULL_PAGE_MAX_HEIGHT). */
  full: ImageHashes;
}

export interface PageFingerprint {
  route: string;
  sections: SectionToken[];
  /** Absent when the page was not rendered (no browser, a page behind a login, a render error). */
  views?: Partial<Record<TemplateViewportId, PageView>>;
}

export interface SiteFingerprint {
  version: 1;
  pages: PageFingerprint[];
}

/** What the gate reads of the composer's site model (V3-12 SiteModel is assignable to it). */
export interface TemplateSite {
  pages: readonly {
    route: string;
    roles?: readonly string[];
    sections: readonly { id?: string; type: string; pattern: string }[];
  }[];
}

/**
 * Pattern lookup: section type, layout family and variant of a pattern id. The caller passes the library's
 * (platform-api: ui-kit patternById), so the gate does not load the pattern sources; without it the layout is unknown.
 */
export type PatternLookup = (
  id: string,
) => { sectionType: string; layout: string; variant: string } | undefined;

/** The structural token of a section: the library pattern's layout and variant, «signature» for free code. */
export function sectionToken(s: { type: string; pattern: string }, lookup?: PatternLookup): SectionToken {
  if (s.type === "signature" || s.pattern === "signature")
    return { type: "signature", layout: "signature", variant: "" };
  const p = lookup?.(s.pattern);
  if (p) return { type: p.sectionType, layout: p.layout, variant: p.variant };
  // A pattern outside the library: <type>-<variant> by the library's naming, layout unknown.
  const variant = s.pattern.startsWith(`${s.type}-`) ? s.pattern.slice(s.type.length + 1) : s.pattern;
  return { type: s.type, layout: "", variant };
}

/** The structural part of a site fingerprint (no browser): the section tokens of every page in the site's order. */
export function siteStructure(site: TemplateSite, lookup?: PatternLookup): SiteFingerprint {
  return {
    version: 1,
    pages: site.pages.map((p) => ({
      route: p.route,
      sections: p.sections.map((s) => sectionToken(s, lookup)),
    })),
  };
}

/**
 * Evaluated in the page (Playwright page.evaluate of a string, so no transpiler helpers leak in): the shapes of the
 * rendered sections in document order. Sections are the children of the app root around <main id="main"> (header,
 * footer) and the children of <main> (the composer wraps each body section in <div id="<section id>">); a page without
 * <main> uses the children of #root. Returns SectionShape[].
 */
export const DOM_SKETCH_SCRIPT = `(() => {
  const vw = window.innerWidth || 1;
  const main = document.getElementById("main");
  const root = main ? main.parentElement : (document.getElementById("root") || document.body);
  const sections = [];
  if (root) for (const el of Array.from(root.children)) {
    if (el === main) sections.push(...Array.from(main.children));
    else sections.push(el);
  }
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const TEXT = new Set(["H1","H2","H3","H4","H5","H6","P","LI","BLOCKQUOTE","DT","DD","FIGCAPTION","TD","TH","LABEL"]);
  const CONTROL = new Set(["A","BUTTON","INPUT","SELECT","TEXTAREA"]);
  const MEDIA = new Set(["IMG","VIDEO","CANVAS","PICTURE","svg"]);
  const out = [];
  for (const s of sections) {
    if (!(s instanceof Element) || !shown(s)) continue;
    const box = s.getBoundingClientRect();
    if (box.height < 4) continue;
    let depth = 0, cols = 1, media = 0, text = 0, controls = 0;
    const minMedia = 0.02 * vw * vw;
    const minCol = Math.max(24, box.width * 0.08);
    const walk = (el, d) => {
      if (d > 24) return;
      depth = Math.max(depth, d);
      const r = el.getBoundingClientRect();
      if (MEDIA.has(el.tagName) && r.width * r.height >= minMedia) media++;
      else if (el.tagName !== "svg" && el.tagName !== "IMG") {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg.includes("url(") && r.width * r.height >= minMedia) media++;
      }
      if (TEXT.has(el.tagName) && (el.textContent || "").trim()) text++;
      if (CONTROL.has(el.tagName)) controls++;
      const kids = Array.from(el.children).filter(shown);
      if (kids.length > 1) {
        // Boxes whose tops are within 4 px form a row; a row counts the boxes that do not overlap horizontally.
        const boxes = kids
          .map((k) => k.getBoundingClientRect())
          .filter((kr) => kr.width >= minCol && kr.height >= 8)
          .sort((a, b) => a.top - b.top || a.left - b.left);
        for (let i = 0; i < boxes.length; i++) {
          const row = boxes.filter((b) => b.top >= boxes[i].top - 0.5 && b.top - boxes[i].top <= 4)
            .sort((a, b) => a.left - b.left);
          let n = 0, right = -Infinity;
          for (const b of row) if (b.left >= right - 2) { n++; right = b.right; }
          cols = Math.max(cols, n);
        }
      }
      if (el.tagName === "svg") return;
      for (const k of kids) walk(k, d + 1);
    };
    walk(s, 0);
    const head = s.querySelector("h1, h2, h3");
    let center = 0;
    if (head && shown(head)) {
      const hr = head.getBoundingClientRect();
      const align = getComputedStyle(head).textAlign;
      const mid = Math.abs(hr.left + hr.width / 2 - (box.left + box.width / 2)) < box.width * 0.05;
      center = align === "center" || (mid && hr.width < box.width * 0.9) ? 1 : 0;
    }
    out.push({ h: Math.round((box.height / vw) * 10) / 10, depth, cols, media, text, controls, center });
  }
  return out;
})()`;
