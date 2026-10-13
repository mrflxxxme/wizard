// V4-18: the stub checks inside a rendered page (Chromium, 390 and 1440): links and buttons that go nowhere, placeholder
// texts as shown, empty sections, one phrase over the cards, cards without a photo among cards with one, contacts the
// owner did not give. The rules are rules.ts's own, built into the script, so the page and the static pass agree.
// A button's click handler is read from React's props on the node (`__reactProps$…`): no onClick, not a form submit,
// no popover or command target — the button does nothing. Sections as the critic sees them: the anchor div of a body
// section in <main>, else header / footer.
import {
  CONTENT_HEADING_RE,
  PLACEHOLDER_PATTERNS,
  PLACEHOLDER_TEXTS,
  type StubCode,
  SYSTEM_ROUTES,
} from "./rules.js";

/** Options of window.__wzStubs.run. */
export interface StubPageOptions {
  /** Route of the page. */
  route: string;
  /** Routes of the site's pages. */
  routes: string[];
  /** Contacts the owner gave (rules.ts knownContacts). */
  contacts: { phones: string[]; emails: string[] };
  /** Sections bound to the owner's data (catalog, blog, cart): empty while there is none — not a stub. */
  dataSections?: string[];
}

/** What the page script returns. */
export interface StubPageResult {
  problems: { code: StubCode; section: string | null; text: string; selector: string; literal: string }[];
}

const RULES = JSON.stringify({
  texts: PLACEHOLDER_TEXTS,
  patterns: PLACEHOLDER_PATTERNS.map((p) => ({ source: p.re.source, flags: p.re.flags, what: p.what })),
  system: SYSTEM_ROUTES,
  heading: { source: CONTENT_HEADING_RE.source, flags: CONTENT_HEADING_RE.flags },
});

/** Defines window.__wzStubs.run(opts) → StubPageResult. */
export const STUB_CHECKS_SCRIPT = String.raw`
(() => {
  const RULES = ${RULES};
  const patterns = RULES.patterns.map((p) => ({ re: new RegExp(p.source, p.flags), what: p.what }));
  const contentHeading = new RegExp(RULES.heading.source, RULES.heading.flags);
  const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/[\s ]+/g, " ").trim().replace(/[.!?:…]+$/, "").trim();
  const placeholderOf = (text) => {
    const t = norm(text);
    if (!t) return null;
    if (RULES.texts.includes(t)) return "«" + text.trim() + "»";
    for (const p of patterns) if (p.re.test(text)) return p.what;
    return null;
  };
  const PHONE = /(?:\+7|8|7)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
  const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const phoneKey = (p) => p.replace(/\D/g, "").slice(-10);
  const strange = (text, known) => {
    const out = [];
    for (const m of text.matchAll(PHONE)) if (!known.phones.includes(phoneKey(m[0])) && !placeholderOf(m[0])) out.push(m[0].trim());
    for (const m of text.matchAll(EMAIL)) { const e = m[0].toLowerCase(); if (!known.emails.includes(e) && !placeholderOf(e)) out.push(m[0]); }
    return out;
  };
  const sameShape = (pattern, path) => {
    const a = pattern.split("/"), b = path.split("/");
    return a.length === b.length && a.every((s, i) => s.startsWith(":") || s === b[i]);
  };
  const deadLink = (href, route, routes, ids) => {
    if (href === null) return null;
    const h = href.trim();
    if (h === "") return "пустая ссылка";
    if (h === "#") return "ссылка «#» никуда не ведёт";
    if (/^javascript:/i.test(h)) return "ссылка-заглушка javascript:";
    if (/^(?:https?:|mailto:|tel:|\/\/|\/_wizard\/|\/api\/)/i.test(h)) return null;
    let path = route, hash = "";
    if (h.startsWith("#")) hash = h.slice(1);
    else { const i = h.indexOf("#"); path = (i < 0 ? h : h.slice(0, i)) || route; hash = i < 0 ? "" : h.slice(i + 1); }
    path = path.split("?")[0];
    if (path.length > 1) path = path.replace(/\/+$/, "");
    if (!h.startsWith("/") && !h.startsWith("#")) return null;
    const known = routes.includes(path) || RULES.system.some((r) => path === r || path.startsWith(r + "/"));
    if (!known && !routes.some((r) => r.includes("/:") && sameShape(r, path))) return "страницы " + path + " на сайте нет";
    if (hash && path === route && !ids.has(decodeURIComponent(hash))) return "якоря #" + hash + " на этой странице нет";
    return null;
  };
  const sectionOf = (el) => {
    const main = document.querySelector("main");
    if (main && main.contains(el)) {
      let n = el;
      while (n && n.parentElement !== main) n = n.parentElement;
      if (n && n.id) return n.id;
      return null;
    }
    if (el.closest("header")) return "header";
    if (el.closest("footer")) return "footer";
    return null;
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 5; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + n.id); break; }
      const tag = n.tagName.toLowerCase();
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(n) + 1) + ")" : tag);
    }
    return parts.join(" > ");
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const reactProps = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"));
    return k ? el[k] : null;
  };
  const short = (s) => (s.length > 80 ? s.slice(0, 79) + "…" : s);
  window.__wzStubs = {
    run(opts) {
      const problems = [];
      const seen = new Set();
      const add = (code, el, text, literal) => {
        const section = sectionOf(el);
        const lit = code === "S04" && !literal.includes("@") ? phoneKey(literal) : literal;
        const k = code + "|" + section + "|" + lit;
        if (seen.has(k)) return;
        seen.add(k);
        problems.push({ code, section, text, selector: selectorOf(el), literal: short(literal) });
      };
      const ids = new Set([...document.querySelectorAll("[id]")].map((e) => e.id));
      // S01: links and buttons that go nowhere.
      for (const a of document.querySelectorAll("a[href]")) {
        if (!visible(a)) continue;
        const why = deadLink(a.getAttribute("href"), opts.route, opts.routes, ids);
        if (why) add("S01", a, why, a.getAttribute("href") || "(пусто)");
        const contact = /^(?:tel|mailto):(.+)$/i.exec(a.getAttribute("href") || "");
        if (contact) for (const c of strange(decodeURIComponent(contact[1]), opts.contacts)) add("S04", a, "контакт " + c + " не из брифа", c);
      }
      for (const b of document.querySelectorAll("button, [role=button]")) {
        if (!visible(b) || b.disabled) continue;
        const p = reactProps(b);
        if (!p) continue;
        const submit = b.tagName === "BUTTON" && (b.getAttribute("type") || "submit") === "submit" && b.closest("form");
        const acts = p.onClick || p.onPointerDown || p.onMouseDown || p.onKeyDown || submit
          || b.hasAttribute("popovertarget") || b.hasAttribute("commandfor") || b.getAttribute("aria-controls")
          || b.closest("a[href], label, summary, [data-wz-action]");
        if (!acts) add("S01", b, "кнопка ничего не делает: нет обработчика", (b.textContent || "").trim() || b.getAttribute("aria-label") || "кнопка");
      }
      // S02, S04: texts as shown (an element's own text nodes), alt texts.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const el = t.parentElement;
        if (!el || el.closest("script, style, noscript, template, [aria-hidden=true]") || !visible(el)) continue;
        const v = (t.nodeValue || "").trim();
        if (!v) continue;
        const p = placeholderOf(v);
        if (p) add("S02", el, "текст-заглушка: " + p, v);
        for (const c of strange(v, opts.contacts)) add("S04", el, "контакт " + c + " не из брифа", c);
      }
      for (const img of document.querySelectorAll("img[alt]")) {
        const p = placeholderOf(img.getAttribute("alt") || "");
        if (p && visible(img)) add("S02", img, "подпись картинки — заглушка: " + p, img.getAttribute("alt"));
      }
      // S03: empty sections, one phrase over the cards, cards without a photo among cards with one.
      const main = document.querySelector("main");
      for (const sec of main ? [...main.children] : []) {
        // An empty section has no height: only display none skips it.
        if (!sec.id || (opts.dataSections || []).includes(sec.id) || getComputedStyle(sec).display === "none") continue;
        const text = (sec.innerText || "").replace(/\s+/g, " ").trim();
        const media = sec.querySelector("img, svg, video, iframe, canvas, form, input, select, textarea, picture");
        if (text.length < 15 && !media) {
          add("S03", sec, "пустая секция", text || "(пусто)");
          continue;
        }
        // One heading that promises content and nothing under it but short buttons («Как работает запись» +
        // «Записаться»); cards (more headings) or a card that is a link are content.
        const heads = [...sec.querySelectorAll("h1, h2, h3, h4, h5, h6")];
        const head = heads.length === 1 ? (heads[0].innerText || "").replace(/\s+/g, " ").trim() : "";
        if (head && !media && contentHeading.test(head)) {
          let rest = "";
          const tw = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
          for (let n = tw.nextNode(); n; n = tw.nextNode()) {
            const el = n.parentElement;
            if (!el || el.closest("h1, h2, h3, h4, h5, h6, button, [role=button]")) continue;
            const a = el.closest("a");
            if (a && (a.innerText || "").trim().length <= 30) continue;
            rest += n.nodeValue || "";
          }
          if (rest.replace(/\s+/g, "").length < 15)
            add("S03", sec, "секция без содержимого: только заголовок и кнопка", head);
        }
      }
      for (const group of document.querySelectorAll("main *")) {
        const kids = [...group.children].filter((c) => visible(c));
        if (kids.length < 2) continue;
        const sig = (c) => c.tagName + "." + [...c.classList].sort().join(".");
        if (!kids.every((c) => sig(c) === sig(kids[0])) || kids[0].children.length === 0) continue;
        const paras = kids.map((c) => [...c.querySelectorAll("p")].map((p) => (p.innerText || "").replace(/\s+/g, " ").trim()).filter((x) => x.length > 12));
        const counts = new Map();
        for (const ps of paras) for (const p of new Set(ps)) counts.set(p, (counts.get(p) || 0) + 1);
        for (const [p, n] of counts) if (n >= 2) add("S03", group, "одна фраза в " + n + " карточках из " + kids.length, p);
        // Cards titled by one word and their numbers («Врач 1», «Врач 2»): demo rows without names.
        const titles = kids.map((c) => { const h = c.querySelector("h2, h3, h4, h5, strong"); return h ? (h.innerText || "").replace(/\s+/g, " ").trim() : ""; });
        const numbered = titles.map((t) => /^(\S.{0,30}?)\s+№?\s*\d{1,3}$/.exec(t)).filter(Boolean);
        if (numbered.length >= 2 && numbered.every((m) => m[1] === numbered[0][1]))
          add("S02", group, "карточки названы «" + numbered[0][1] + " N» — демо-строки без названий", titles.filter(Boolean).slice(0, 3).join(", "));
        const withImg = kids.filter((c) => c.querySelector("img")).length;
        // Three cards at least: two siblings of one class are as often the columns of a split (text | photo).
        if (withImg > 0 && withImg < kids.length && kids.length >= 3 && kids.length <= 12)
          add("S03", group, "карточки без фото: " + (kids.length - withImg) + " из " + kids.length + ", у остальных фото есть", (kids.length - withImg) + " из " + kids.length);
      }
      return { problems };
    },
  };
})();
`;
