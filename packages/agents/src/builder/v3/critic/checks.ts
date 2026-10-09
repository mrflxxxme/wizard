// In-page checks of the visual critic (V3-13; design-agent-catalog.md B, column «код»): the production copy of the
// checks of the pattern and composer browser tests (contrast incl. text over photos, overflow, names and alt, heading
// order, touch targets) plus the design fonts loaded (T16), layout shift during load (CLS), the first screen action
// above the fold on a phone (L13), content hidden at rest (M05) and broken images (I03). Colours go through a canvas, so
// OKLCH and color-mix() of Tailwind v4 are measured like any colour; a photo or gradient under a text counts as
// unknown — the text must hold against white and black. Every problem names the section it is in: the anchor div of a
// body section in <main> (pageSource of the composer), else header / footer by position.
import type { CheckCode } from "./rubric.js";

/** Viewports of the checks: the screenshot widths in the light theme, the phone in the dark one. */
export const CRITIC_VIEWPORTS: readonly CriticViewport[] = [
  { width: 390, height: 844, scheme: "light" },
  { width: 768, height: 1024, scheme: "light" },
  { width: 1440, height: 900, scheme: "light" },
  { width: 390, height: 844, scheme: "dark" },
];

export interface CriticViewport {
  width: number;
  height: number;
  scheme: "light" | "dark";
}

/** Options of window.__wzCritic.run. */
export interface CriticCheckOptions {
  /** Families of the design system (display, text) that must be loaded. */
  fonts: string[];
  /** Touch targets are checked (≤ 1024 px). */
  touch: boolean;
  /** Height of the first screen for the action check (390×844), null — not checked. */
  fold: number | null;
}

/** What the page script returns. */
export interface CriticCheckResult {
  problems: { code: CheckCode; section: string | null; text: string }[];
  /** Cumulative layout shift since the document started (no input). */
  cls: number;
  /** Document width over the viewport, px. */
  scroll: number;
  /** Boxes of the page's sections in document px (header, the body sections, footer). */
  sections: { id: string; top: number; height: number }[];
  height: number;
}

/** CLS > this is a problem (Web Vitals «good»). */
export const CLS_LIMIT = 0.1;

/** Installed before any script of the page: the layout-shift observer (CLS) since navigation. */
export const CRITIC_INIT_SCRIPT = `
(() => {
  const state = { value: 0, nodes: [] };
  window.__wzCls = state;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        state.value += e.value;
        for (const s of e.sources || []) if (s.node && state.nodes.length < 20) state.nodes.push(s.node);
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {}
})();
`;

/** Defines window.__wzCritic.run(opts) → CriticCheckResult. */
export const CRITIC_CHECKS_SCRIPT = String.raw`
(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
  });
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const BLACK = { r: 0, g: 0, b: 0, a: 1 };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const hidden = (el) => !!el.closest("[aria-hidden=true], svg, [data-a11y-skip]");
  const media = (el) => {
    if (["IMG", "VIDEO", "CANVAS", "PICTURE", "IFRAME"].includes(el.tagName)) return true;
    return getComputedStyle(el).backgroundImage !== "none";
  };
  const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const desc = (el) => el.tagName.toLowerCase() + " «" + (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) + "»";

  // The section of an element: the anchor div of a body section in <main>, else header / footer by position.
  const main = () => document.querySelector("main#main") || document.querySelector("main");
  const sectionOf = (el) => {
    const m = main();
    if (!m || !el) return null;
    if (m.contains(el)) {
      for (let e = el; e && e !== m; e = e.parentElement) if (e.parentElement === m && e.id) return e.id;
      return null;
    }
    return m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING ? "header" : "footer";
  };
  const out = [];
  const add = (code, el, text) => out.push({ code, section: el === null ? null : sectionOf(el), text });

  const backdrops = (el, x, y) => {
    const stack = document.elementsFromPoint(x, y);
    let i = stack.indexOf(el);
    if (i < 0) i = stack.findIndex((e) => e.contains(el));
    if (i < 0) return null;
    const layers = [];
    for (const e of stack.slice(i)) {
      if (media(e) && e !== el) return { layers, base: null };
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 0.999) return { layers, base: c }; }
    }
    const root = rgba(getComputedStyle(document.documentElement).backgroundColor);
    return { layers, base: root.a > 0 ? over(root, WHITE) : WHITE };
  };

  const texts = () => {
    const els = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent.trim() || seen.has(el) || hidden(el) || !visible(el)) continue;
      seen.add(el);
      els.push([el, n]);
    }
    return els;
  };

  // M05 and C08 share the text walk: a text at rest with opacity ≈ 0 is hidden, not low-contrast.
  const contrastAndHidden = (items) => {
    const range = document.createRange();
    const perSection = new Map();
    for (const [el, n] of items) {
      const op = opacity(el);
      if (op < 0.1) { add("M05", el, desc(el) + ": прозрачность " + op.toFixed(2)); continue; }
      range.selectNodeContents(n);
      if (!range.getClientRects()[0]) continue;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = range.getClientRects()[0];
      if (!r || r.width < 1) continue;
      const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 12), 0), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const bd = backdrops(el, x, y);
      if (!bd) continue;
      const s = getComputedStyle(el);
      const fg0 = rgba(s.color);
      const fg = { ...fg0, a: fg0.a * op };
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      const bases = bd.base ? [bd.base] : [WHITE, BLACK];
      let worst = Infinity;
      for (const base of bases) {
        let bg = base;
        for (let i = bd.layers.length - 1; i >= 0; i--) if (bd.layers[i] !== base) bg = over(bd.layers[i], bg);
        worst = Math.min(worst, ratio(over(fg, bg), bg));
      }
      if (worst + 0.01 < need) {
        const key = sectionOf(el) || "";
        const k = (perSection.get(key) || 0) + 1;
        perSection.set(key, k);
        if (k <= 2) add("C08", el, desc(el) + ": контраст " + worst.toFixed(2) + " при норме " + need + (bd.base ? "" : " (текст на фото)"));
      }
    }
  };

  const overflow = () => {
    const clipped = (el) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement)
        if (getComputedStyle(e).overflowX !== "visible") return true;
      return false;
    };
    const per = new Set();
    for (const el of document.body.querySelectorAll("*")) {
      if (!visible(el) || hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > innerWidth + 1 || r.left < -1) && !clipped(el)) {
        const key = sectionOf(el) || "";
        if (per.has(key)) continue;
        per.add(key);
        add("L11", el, desc(el) + " выходит за экран: " + Math.round(r.left) + "…" + Math.round(r.right) + " px при ширине " + innerWidth);
        if (per.size >= 5) break;
      }
    }
    const scroll = document.documentElement.scrollWidth - innerWidth;
    if (scroll > 1 && per.size === 0) add("L11", null, "страница шире экрана на " + scroll + " px");
    return scroll;
  };

  const touch = () => {
    const per = new Map();
    for (const el of document.body.querySelectorAll("a[href], button, [role=button], input, select, summary")) {
      if (!visible(el) || hidden(el)) continue;
      const s = getComputedStyle(el);
      const around = [...(el.parentElement ? el.parentElement.childNodes : [])]
        .filter((n) => n.nodeType === 3).map((n) => n.textContent || "").join("").trim().length;
      if (s.display === "inline" && around > 20) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) {
        const key = sectionOf(el) || "";
        const k = (per.get(key) || 0) + 1;
        per.set(key, k);
        if (k <= 2) add("A01", el, desc(el) + " " + Math.round(r.width) + "×" + Math.round(r.height) + " px — меньше 44×44");
      }
    }
  };

  const names = () => {
    for (const el of document.body.querySelectorAll("a[href], button, [role=button]")) {
      if (!visible(el)) continue;
      const imgAlt = [...el.querySelectorAll("img")].map((i) => i.getAttribute("alt") || "").join("");
      if (!((el.textContent || "").trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || imgAlt.trim()))
        add("A08", el, el.tagName.toLowerCase() + " без имени");
    }
    for (const img of document.body.querySelectorAll("img")) {
      const alt = img.getAttribute("alt");
      if (alt === null) add("A08", img, "картинка без alt: " + (img.getAttribute("src") || ""));
      else if (alt === "" && !img.closest("[aria-hidden=true]") && img.getAttribute("role") !== "presentation")
        add("A08", img, "картинка с пустым alt без aria-hidden: " + (img.getAttribute("src") || ""));
      if (img.complete && img.naturalWidth === 0) add("I03", img, "картинка не загрузилась: " + (img.getAttribute("src") || ""));
    }
  };

  const headings = () => {
    const hs = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(visible);
    const h1 = hs.filter((h) => h.tagName === "H1");
    if (h1.length !== 1) add("A06", h1[1] || null, h1.length + " h1 на странице");
    for (let i = 1; i < hs.length; i++) {
      const a = Number(hs[i - 1].tagName[1]), b = Number(hs[i].tagName[1]);
      if (b > a + 1) { add("A06", hs[i], "h" + a + " → h" + b + ": " + desc(hs[i])); break; }
    }
  };

  const unquote = (f) => f.replace(/^["']|["']$/g, "").trim().toLowerCase();
  const fonts = (families) => {
    const faces = [...document.fonts];
    for (const fam of families) {
      const own = faces.filter((f) => unquote(f.family) === unquote(fam));
      if (own.length === 0) { add("T16", null, "шрифт «" + fam + "» не объявлен на странице"); continue; }
      if (own.some((f) => f.status === "error")) { add("T16", null, "шрифт «" + fam + "» не загрузился"); continue; }
      const used = [...document.querySelectorAll("h1, h2, h3, p, a, button, li")].some((el) =>
        visible(el) && unquote(getComputedStyle(el).fontFamily.split(",")[0] || "") === unquote(fam));
      if (used && !own.some((f) => f.status === "loaded")) add("T16", null, "шрифт «" + fam + "» не успел загрузиться — текст показан запасным");
    }
  };

  const fold = (h) => {
    const m = main();
    const hero = document.getElementById("hero") || (m && [...m.children].find((e) => e.id));
    if (!hero) return;
    const action = [...hero.querySelectorAll("a[href], button")].find(visible);
    if (!action) return;
    const r = action.getBoundingClientRect();
    const bottom = r.top + window.scrollY + r.height;
    if (bottom > h) add("L13", action, desc(action) + " ниже первого экрана: низ на " + Math.round(bottom) + " px при высоте " + h);
  };

  const sections = () => {
    const m = main();
    const out = [];
    const doc = document.documentElement.scrollHeight;
    if (!m) return out;
    const mr = m.getBoundingClientRect();
    const top = mr.top + window.scrollY;
    if (top > 4) out.push({ id: "header", top: 0, height: Math.round(top) });
    for (const e of m.children) {
      if (!e.id) continue;
      const r = e.getBoundingClientRect();
      out.push({ id: e.id, top: Math.round(r.top + window.scrollY), height: Math.round(r.height) });
    }
    const bottom = top + mr.height;
    if (doc - bottom > 4) out.push({ id: "footer", top: Math.round(bottom), height: Math.round(doc - bottom) });
    return out;
  };

  window.__wzCritic = {
    run(opts) {
      window.scrollTo(0, 0);
      const cls = window.__wzCls || { value: 0, nodes: [] };
      if (cls.value > ${CLS_LIMIT}) {
        const where = [...new Set(cls.nodes.map((n) => sectionOf(n.nodeType === 1 ? n : n.parentElement)).filter(Boolean))];
        out.push({ code: "CLS", section: where[0] || null, text: "сдвиг вёрстки при загрузке: CLS " + cls.value.toFixed(3) + (where.length ? " (" + where.join(", ") + ")" : "") });
      }
      const root = document.getElementById("root");
      if (!root || root.children.length === 0 || !main()) add("RENDER", null, "страница пустая: нет разметки сайта");
      const boxes = sections();
      if (opts.fold) fold(opts.fold);
      fonts(opts.fonts || []);
      const scroll = overflow();
      names();
      headings();
      if (opts.touch) touch();
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
      document.head.append(style);
      contrastAndHidden(texts());
      style.remove();
      window.scrollTo(0, 0);
      return { problems: out.splice(0), cls: cls.value, scroll, sections: boxes, height: document.documentElement.scrollHeight };
    },
  };
})();
`;
