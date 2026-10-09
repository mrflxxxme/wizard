// In-page checks of the v3 pattern matrix, per [data-preview] root. Colours go through a canvas, so OKLCH and
// color-mix() of Tailwind v4 are measured like any colour; the backdrop of a text is read from the paint order at
// the text (elementsFromPoint), and a photo or gradient under it counts as unknown: the text must hold against white
// and black (a scrim that works only over a dark photo fails).
export const V3_CHECKS_SCRIPT = String.raw`
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

  // Backdrop layers under a point of el, top to bottom, until an opaque one; unknown when a photo is under it.
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

  const contrast = (root) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent.trim() || seen.has(el) || hidden(el) || !visible(el)) continue;
      seen.add(el);
      range.selectNodeContents(n);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width < 1) continue;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = range.getClientRects()[0];
      const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 12), 0), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const bd = backdrops(el, x, y);
      if (!bd) { out.push(desc(el) + ": не найден под точкой"); continue; }
      const s = getComputedStyle(el);
      const fg0 = rgba(s.color);
      const fg = { ...fg0, a: fg0.a * opacity(el) };
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
      if (worst + 0.01 < need) out.push(desc(el) + " → " + worst.toFixed(2) + (bd.base ? "" : " (на фото)"));
    }
    return out;
  };

  const overflow = (root) => {
    const out = [];
    const clipped = (el) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
        const o = getComputedStyle(e).overflowX;
        if (o !== "visible") return true;
      }
      return false;
    };
    for (const el of root.querySelectorAll("*")) {
      if (!visible(el) || hidden(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > innerWidth + 1 || r.left < -1) && !clipped(el)) out.push(desc(el) + " " + Math.round(r.left) + "…" + Math.round(r.right));
      if (out.length >= 3) break;
    }
    return out;
  };

  const touch = (root) => {
    const out = [];
    for (const el of root.querySelectorAll("a[href], button, [role=button], input, select, summary")) {
      if (!visible(el) || hidden(el)) continue;
      const s = getComputedStyle(el);
      // A link inside a sentence (own text of the parent around it) is exempt, like WCAG 2.5.8 inline targets.
      const around = [...(el.parentElement?.childNodes ?? [])]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || "")
        .join("")
        .trim().length;
      const inSentence = s.display === "inline" && around > 20;
      if (inSentence) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) out.push(desc(el) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    }
    return out;
  };

  const names = (root) => {
    const out = [];
    for (const el of root.querySelectorAll("a[href], button, [role=button]")) {
      if (!visible(el)) continue;
      const imgAlt = [...el.querySelectorAll("img")].map((i) => i.getAttribute("alt") || "").join("");
      if (!((el.textContent || "").trim() || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || imgAlt.trim()))
        out.push(el.tagName.toLowerCase() + " без имени");
    }
    for (const img of root.querySelectorAll("img")) {
      const alt = img.getAttribute("alt");
      if (alt === null) out.push("img без alt: " + img.getAttribute("src"));
      else if (alt === "" && !img.closest("[aria-hidden=true]") && img.getAttribute("role") !== "presentation")
        out.push("img с пустым alt без aria-hidden: " + img.getAttribute("src"));
      if (img.complete && img.naturalWidth === 0) out.push("img не загрузилось: " + img.getAttribute("src"));
    }
    return out;
  };

  const headings = (root, hero) => {
    const out = [];
    const levels = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(visible).map((h) => Number(h.tagName[1]));
    const h1 = levels.filter((l) => l === 1).length;
    if (hero ? h1 !== 1 : h1 !== 0) out.push(h1 + " h1");
    for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) out.push("h" + levels[i - 1] + " → h" + levels[i]);
    return out;
  };

  window.__v3 = {
    run(opts) {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
      document.head.append(style);
      const result = {};
      for (const root of document.querySelectorAll("[data-preview]")) {
        const id = root.getAttribute("data-preview");
        const r = root.getBoundingClientRect();
        const problems = [
          ...(r.height < 24 || root.children.length === 0 ? ["пустой рендер"] : []),
          ...overflow(root).map((p) => "переполнение: " + p),
          ...contrast(root).map((p) => "контраст: " + p),
          ...names(root).map((p) => "доступность: " + p),
          // An entry page (article-*, V3-24) is the heading of its page like a first screen: one h1.
          ...headings(root, id.startsWith("hero-") || id.startsWith("article-")).map((p) => "заголовки: " + p),
          ...(opts.touch ? touch(root).map((p) => "касание: " + p) : []),
        ];
        if (problems.length) result[id] = problems;
      }
      style.remove();
      window.scrollTo(0, 0);
      return { result, scroll: document.documentElement.scrollWidth - innerWidth };
    },
  };
})();
`;

export type V3CheckResult = { result: Record<string, string[]>; scroll: number };
