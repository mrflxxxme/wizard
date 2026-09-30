// In-page a11y/responsive/wz_id checks (ui-kit.yaml#a11y tests; own scripts instead of axe-core, a11y#tooling).
// Injected as plain JS via page.addScriptTag so the bundler cannot rewrite it; results are lists of problems.
export const A11Y_SCRIPT = String.raw`
(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
  });
  const background = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (rootBg && rootBg.a > 0) bg = over(rootBg, bg);
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const inactive = (el) => !!el.closest(":disabled, [aria-disabled=true], [aria-hidden=true], option, svg, [data-a11y-skip]");
  const faded = (el) => { for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) < 1) return true; return false; };
  const desc = (el) => (el.getAttribute("data-testid") || el.tagName.toLowerCase()) + ": " + (el.textContent || "").trim().slice(0, 40);

  window.__a11y = {
    contrast() {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || seen.has(el) || !n.textContent.trim() || !visible(el) || inactive(el) || faded(el)) continue;
        seen.add(el);
        const s = getComputedStyle(el);
        if (s.clip === "rect(0px, 0px, 0px, 0px)") continue;
        const fg = parse(s.color);
        if (!fg) continue;
        const bg = background(el);
        const size = parseFloat(s.fontSize);
        const large = size >= 24 || (size >= 19 && Number(s.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        const r = ratio(over(fg, bg), bg);
        if (r + 0.01 < need) out.push(desc(el) + " → " + r.toFixed(2));
      }
      return out;
    },
    labels() {
      const out = [];
      for (const el of document.querySelectorAll("input, select, textarea")) {
        if (el.type === "hidden" || !visible(el)) continue;
        const named = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") ||
          (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest("label");
        if (!named) out.push(desc(el) + " #" + el.id);
      }
      return out;
    },
    touch() {
      const out = [];
      const sel = "button, a[role=button], input, select, [role=tab], [role=checkbox], [role=radio]";
      for (const el of document.querySelectorAll(sel)) {
        if (el.type === "hidden" || !visible(el) || el.closest("[data-a11y-skip]")) continue;
        const box = (e) => { const r = e.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5; };
        const label = el.closest("label") || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
        if (!box(el) && !(label && box(label))) {
          const r = el.getBoundingClientRect();
          out.push(desc(el) + " " + Math.round(r.width) + "×" + Math.round(r.height));
        }
      }
      return out;
    },
    wz(names) {
      const out = [];
      for (const el of document.querySelectorAll("[data-wz-component]")) {
        const n = el.getAttribute("data-wz-component");
        if (!el.getAttribute("data-wz-id")) out.push(n + ": пустой data-wz-id");
        if (!names.includes(n)) out.push(n + ": нет в ui-kit.yaml#components");
      }
      return out;
    },
    overflow() {
      return document.documentElement.scrollWidth <= window.innerWidth ? [] :
        ["scrollWidth " + document.documentElement.scrollWidth + " > " + window.innerWidth];
    },
    focusables() {
      return document.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])").length;
    },
  };
})();
`;

export type A11yApi = {
  contrast(): string[];
  labels(): string[];
  touch(): string[];
  wz(names: string[]): string[];
  overflow(): string[];
  focusables(): number;
};
