// Page → clean markdown (builder-v3.md §1 «Чтение страниц»): linkedom DOM, @mozilla/readability for the main content
// (fallback: the body without navigation), Turndown to markdown. Libraries load on first use: importing
// @wizard/agents does not pull them in.

/** Markdown kept per page (the tool hands the model a smaller slice). */
export const PAGE_MAX_CHARS = 60_000;

/** Elements that never become markdown: media, scripts, forms, page chrome of the fallback. */
const DROP = new Set([
  "img",
  "picture",
  "video",
  "audio",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "script",
  "style",
  "noscript",
  "template",
  "form",
  "button",
  "select",
  "input",
  "textarea",
]);
const CHROME =
  "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]";

export interface ExtractedPage {
  title: string;
  markdown: string;
  truncated: boolean;
  lang: string | null;
}

interface Libs {
  parseHTML: (html: string) => { document: Document };
  Readability: new (
    doc: Document,
    opts?: { maxElemsToParse?: number; charThreshold?: number },
  ) => { parse(): { title?: string | null; content?: string | null; textContent?: string | null } | null };
  Turndown: typeof import("turndown");
}

let libs: Promise<Libs> | null = null;

function loadLibs(): Promise<Libs> {
  libs ??= Promise.all([import("linkedom"), import("@mozilla/readability"), import("turndown")]).then(
    ([linkedom, readability, turndown]) => ({
      parseHTML: linkedom.parseHTML as unknown as Libs["parseHTML"],
      Readability: readability.Readability as unknown as Libs["Readability"],
      Turndown: turndown.default,
    }),
  );
  return libs;
}

/** Links absolute against the page address; javascript: and broken ones lose their href. */
function absolutizeLinks(doc: Document, base: string): void {
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    try {
      const u = new URL(href, base);
      if (["http:", "https:", "mailto:", "tel:"].includes(u.protocol)) a.setAttribute("href", u.href);
      else a.removeAttribute("href");
    } catch {
      a.removeAttribute("href");
    }
  }
}

/** Cuts markdown at a line end not far before `max` characters. */
export function cutMarkdown(md: string, max: number): { text: string; truncated: boolean } {
  if (md.length <= max) return { text: md, truncated: false };
  const nl = md.lastIndexOf("\n", max);
  return { text: md.slice(0, nl > max * 0.8 ? nl : max).trimEnd(), truncated: true };
}

/** HTML of a page at `baseUrl` → title and markdown of its main content (≤ maxChars). */
export async function htmlToMarkdown(
  html: string,
  baseUrl: string,
  maxChars: number = PAGE_MAX_CHARS,
): Promise<ExtractedPage> {
  const { parseHTML, Readability, Turndown } = await loadLibs();
  const { document } = parseHTML(html);
  absolutizeLinks(document, baseUrl);
  const lang = document.documentElement?.getAttribute("lang") ?? null;
  let title = (document.querySelector("title")?.textContent ?? "").replace(/\s+/g, " ").trim();
  let content: string | null = null;
  try {
    const article = new Readability(document, { maxElemsToParse: 50_000, charThreshold: 300 }).parse();
    if (article?.content && (article.textContent ?? "").trim().length >= 200) {
      content = article.content;
      if (article.title) title = article.title.replace(/\s+/g, " ").trim();
    }
  } catch {
    // Readability gives up on odd markup: the fallback below still extracts the text.
  }
  if (content === null) {
    const { document: whole } = parseHTML(html);
    absolutizeLinks(whole, baseUrl);
    for (const el of Array.from(whole.querySelectorAll(CHROME))) el.remove();
    content = whole.querySelector("main")?.innerHTML ?? whole.body?.innerHTML ?? "";
  }
  const td = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.addRule("wizard-drop", {
    filter: (node) => DROP.has(node.nodeName.toLowerCase()),
    replacement: () => "",
  });
  const markdown = td
    .turndown(content)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const cut = cutMarkdown(markdown, maxChars);
  return { title, markdown: cut.text, truncated: cut.truncated, lang };
}
