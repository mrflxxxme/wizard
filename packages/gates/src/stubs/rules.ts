// V4-18 «Без заглушек»: what a stub is. The same rules serve the static pass over the site's TSX (static.ts) and the
// page script in Chromium (page.ts), so the two never disagree. Codes:
//   S01 — a dead link or control: href "#", empty or javascript:, a page or an anchor the site does not have, an empty
//         click handler;
//   S02 — placeholder text: lorem ipsum, «Заголовок», «Описание услуги», «Иван Иванов», example.com, phones of zeros or
//         123-45-67, «скоро здесь», TODO;
//   S03 — an empty or near-empty section, one phrase repeated over the cards, cards without a photo where their
//         siblings have one;
//   S04 — a phone or an e-mail the owner never gave (not in the brief, the chat or the operator's data).

export const STUB_CODES = ["S01", "S02", "S03", "S04"] as const;
export type StubCode = (typeof STUB_CODES)[number];

/** What each code catches (Russian, for the critic's prompt and the notes) and how bad it is (critic severities). */
export const STUB_RUBRIC: Readonly<Record<StubCode, { label: string; severity: "P1" | "P2" }>> = {
  S01: {
    label: "мёртвая ссылка или кнопка: никуда не ведёт или ведёт на несуществующую страницу",
    severity: "P1",
  },
  S02: { label: "текст-заглушка вместо настоящего текста", severity: "P1" },
  S03: { label: "пустая секция, повтор одной фразы в карточках или карточка без фото", severity: "P2" },
  S04: { label: "контакт, которого владелец не давал", severity: "P1" },
};

/** One finding. `file` and `literal` come from the static pass, `selector` and `section` from the page. */
export interface StubFinding {
  code: StubCode;
  /** Route of the page («/», «/services»). */
  route: string;
  /** Source file (static pass). */
  file?: string;
  /** The offending literal, as written (static pass) or as shown (page). */
  literal?: string;
  /** CSS path of the element (page). */
  selector?: string;
  /** Section id of the page (anchor of a body section, «header», «footer»); null — the page as a whole. */
  section: string | null;
  message_ru: string;
}

/** Whole texts that are placeholders (compared trimmed, lower case, «ё» as «е», without the final punctuation). */
export const PLACEHOLDER_TEXTS: readonly string[] = [
  "заголовок",
  "подзаголовок",
  "заголовок секции",
  "заголовок страницы",
  "текст",
  "текст секции",
  "ваш текст",
  "описание услуги",
  "описание товара",
  "краткое описание",
  "название услуги",
  "название товара",
  "имя фамилия",
  "иван иванов",
  "иванов иван",
  "петр петров",
  "john doe",
  "jane doe",
  "отзыв клиента",
  "title",
  "subtitle",
  "description",
  "text",
  "button",
  "placeholder",
];

/** Placeholder fragments anywhere in a text. */
export const PLACEHOLDER_PATTERNS: readonly { re: RegExp; what: string }[] = [
  { re: /lorem\s+ipsum|dolor\s+sit\s+amet|consectetur\s+adipiscing/i, what: "lorem ipsum" },
  { re: /\b(?:todo|fixme|tbd)\b/i, what: "TODO" },
  { re: /(?:^|[\s@/.])example\.(?:com|org|net|ru)\b/i, what: "example.com" },
  { re: /\b(?:test|user|email|mail|name)@(?:test|mail|site|domain|example)\.\w+/i, what: "адрес-заглушка" },
  { re: /\+?[78][\s(-]*0{3}[\s)-]*0{3}[\s-]*0{2}[\s-]*0{2}\b/, what: "телефон из нулей" },
  // 123-45-67 on its own or after a dummy code; a real number may end with it («+7 916 123-45-67»).
  { re: /(?<![\d)][\s(-]*)123[\s-]?45[\s-]?67(?!\d)/, what: "телефон 123-45-67" },
  { re: /\(?(?:000|111|999|123)\)?[\s-]*123[\s-]?45[\s-]?67(?!\d)/, what: "телефон 123-45-67" },
  { re: /\+?[78][\s(-]*9{3}[\s)-]*9{3}[\s-]*9{2}[\s-]*9{2}\b/, what: "телефон из девяток" },
  {
    re: /скоро\s+(?:здесь|тут)|скоро\s+появ|здесь\s+будет|coming\s+soon|under\s+construction/i,
    what: "«скоро здесь»",
  },
  {
    re: /текст[-\s]рыба|рыба[-\s]текст|\[(?:текст|название|имя|описание)[^\]]*\]|\{\{[^}]*\}\}|<(?:текст|название)>/i,
    what: "шаблон текста",
  },
  { re: /(?:^|\s)(?:x{3,}|х{3,})(?:\s|$)/i, what: "xxx" },
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s ]+/g, " ")
    .trim()
    .replace(/[.!?:…]+$/, "")
    .trim();

/** The placeholder a text is or holds; null — none. */
export function placeholderOf(text: string): string | null {
  const t = norm(text);
  if (!t) return null;
  if (PLACEHOLDER_TEXTS.includes(t)) return `«${text.trim()}»`;
  for (const p of PLACEHOLDER_PATTERNS) if (p.re.test(text)) return p.what;
  return null;
}

/** Phones (Russian numbers of 11 digits from 7/8, or +7) and e-mails in a text. */
const PHONE_RE = /(?:\+7|8|7)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** A phone as its last 10 digits («+7 (900) 000-11-22» → «9000001122»). */
export const phoneKey = (p: string): string => p.replace(/\D/g, "").slice(-10);

export interface KnownContacts {
  phones: string[];
  emails: string[];
}

/** Phones and e-mails of the owner's texts (brief, chat, the operator's data): the contacts the site may show. */
export function knownContacts(texts: readonly string[]): KnownContacts {
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(PHONE_RE)) phones.add(phoneKey(m[0]));
    for (const m of t.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  }
  return { phones: [...phones], emails: [...emails] };
}

/** Contacts of a text the owner did not give (placeholder phones and e-mails are S02, not counted here). */
export function strangeContacts(text: string, known: KnownContacts): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PHONE_RE))
    if (!known.phones.includes(phoneKey(m[0])) && !placeholderOf(m[0])) out.push(m[0].trim());
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (!known.emails.includes(e) && !placeholderOf(e)) out.push(m[0]);
  }
  return out;
}

/** Routes every site has besides its pages (runtime and platform pages). */
export const SYSTEM_ROUTES: readonly string[] = [
  "/login",
  "/logout",
  "/privacy",
  "/photos",
  "/account",
  "/cabinet",
];

/** Why a link is dead; null — it goes somewhere. `routes` — the site's pages, `anchors` — ids by route. */
export function deadLink(
  href: string | null | undefined,
  at: { route: string; routes: readonly string[]; anchors?: ReadonlyMap<string, ReadonlySet<string>> },
): string | null {
  if (href === null || href === undefined) return null;
  const h = href.trim();
  if (h === "") return "пустая ссылка";
  if (h === "#") return "ссылка «#» никуда не ведёт";
  if (/^javascript:/i.test(h)) return "ссылка-заглушка javascript:";
  if (/^(?:https?:|mailto:|tel:|\/\/|\/_wizard\/|\/api\/)/i.test(h)) return null;
  const [pathPart, hash] = h.startsWith("#")
    ? [at.route, h.slice(1)]
    : (h.split("#", 2) as [string, string?]);
  const path = (pathPart || at.route).split("?")[0] as string;
  if (h.startsWith("/") || h.startsWith("#")) {
    const route = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const known =
      at.routes.includes(route) || SYSTEM_ROUTES.some((r) => route === r || route.startsWith(`${r}/`));
    if (!known && !/\/:[a-z]/i.test(route) && !at.routes.some((r) => r.includes("/:") && sameShape(r, route)))
      return `страницы ${route} на сайте нет`;
    if (hash && at.anchors) {
      const ids = at.anchors.get(route);
      if (ids && !ids.has(decodeURIComponent(hash))) return `якоря #${hash} на странице ${route} нет`;
    }
  }
  return null;
}

/** A dynamic route («/services/:id») matches a path of the same depth. */
const sameShape = (pattern: string, path: string) => {
  const a = pattern.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((s, i) => s.startsWith(":") || s === b[i]);
};
