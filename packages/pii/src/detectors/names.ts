// person_name / person_name_latin (data-boundary.yaml#detectors.kinds): dictionary first names + capitalization, extended by
// adjacent patronymics/surnames; "Фамилия И. О." and "И. О. Фамилия"; values after «ФИО:».
import { nameDict } from "../dict.js";
import type { Confidence, Finding } from "../types.js";
import { finding, fold } from "../util.js";

const WORD_RE = /\p{L}+(?:-\p{L}+)*/gu;
// Only capitalized words can be part of a name; adjacency is checked on the text between them.
const CAP_WORD_RE = /(?<!\p{L})\p{Lu}\p{L}*(?:-\p{L}+)*/gu;
const CYR = /^[\p{Script=Cyrillic}-]+$/u;
const LAT = /^[A-Za-z-]+$/;

const PATRONYMIC_CYR =
  /^[А-ЯЁ][а-яё]+(?:(?:ович|евич|ьич|ич)(?:а|у|ем|ом|е)?|(?:овн|евн|ичн|иничн)(?:а|ы|е|у|ой|ою))$/u;
const PATRONYMIC_LAT = /^[A-Z][a-z]+(?:ovich|evich|ovna|evna|ichna|yich)$/;
export const SURNAME_SUFFIX_CYR =
  /^[А-ЯЁ][а-яё]+(?:(?:ов|ев|ёв|ин|ын)(?:а|у|ым|ом|е|ой|ы|ых|ыми)?|(?:ск|цк)(?:ий|ая|ой|ого|ому|им|ом|ую|ие|их)|енко|[уюч]к(?:а|у|ом|е)?|янц?|швили|дзе|[ыи]х|[ое]вич(?:а|у|ем|ом|е)?)$/u;
const SURNAME_SUFFIX_LAT =
  /^[A-Z][a-z]+(?:ov|ev|yov|in|yn|sky|skiy|skii|ski|skaya|ova|eva|yova|ina|yna|enko|uk|yuk|chuk|yan|shvili|dze|ikh|ykh|vich)$/;
// Capitalized common words that end like a surname.
const NOT_SURNAME = new Set(
  (
    "магазин бензин керосин витамин жасмин апельсин мандарин карантин кофеин клавиш один готов основ итогов " +
    "домов часов слов регионов городов товаров заказов цветов login admin plugin begin domain origin within margin " +
    "cabin cousin basin robin kevin martin main join coin skin pin bin"
  ).split(" "),
);
// Capitalized non-name words that the tokenizer would otherwise accept as names at sentence start.
const STREET_BEFORE =
  /(?:(?<!\p{L})(?:ул|пр|просп|пер|пл|наб|б-р|пр-т|пр-кт|ш|им|ст|м|г|пос|мкр|обл)\.?|улиц\p{L}*|проспект\p{L}*|переул\p{L}*|площад\p{L}*|бульвар\p{L}*|набережн\p{L}*|шоссе|имени|памятник\p{L}*|станци\p{L}*|метро|город\p{L}*|район\p{L}*|област\p{L}*|посел\p{L}*|посёл\p{L}*|сел\p{L}*|деревн\p{L}*|аэропорт\p{L}*|вокзал\p{L}*|театр\p{L}*|музе\p{L}*|школ\p{L}*|храм\p{L}*|собор\p{L}*|фестивал\p{L}*|форум\p{L}*|бренд\p{L}*|марк\p{L}*|компани\p{L}*|магазин\p{L}*|салон\p{L}*|кафе|ресторан\p{L}*|гостиниц\p{L}*|отел\p{L}*|студи\p{L}*|агентств\p{L}*|клиник\p{L}*|фирм\p{L}*|бар\p{L}*|кинотеатр\p{L}*|ооо|оао|зао|пао)[ \xa0]*[«"„]?[ \xa0]*$/iu;
const LOCATION_PREP = /(?<!\p{L})(?:в|во|из|под|до|около|через)[ \xa0]+$/iu;
const LOCATION_NAMES = new Set([
  "владимир",
  "владимира",
  "владимире",
  "владимиру",
  "владимиром",
  "лена",
  "лены",
  "лене",
]);

const FIO_LABEL_RE =
  /(?<!\p{L})(?:ФИО|Ф\.[ \xa0]?И\.[ \xa0]?О\.|Фамилия(?:,[ \xa0]*имя(?:,[ \xa0]*отчество)?)?|ф\.и\.о\.|фио)[ \xa0]*[:\-—–]?[ \xa0]*((?:[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?(?:[ \xa0]+|$|(?=[,.;)]))){1,3})/gu;
// Sticky: applied at token boundaries.
const INITIALS_AFTER_RE = /[ \xa0]+([А-ЯЁA-Z])\.(?:[ \xa0]?([А-ЯЁA-Z])\.)?/uy;
const INITIALS_BEFORE_RE =
  /([А-ЯЁA-Z])\.[ \xa0]?(?:([А-ЯЁA-Z])\.[ \xa0]?)?([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?|[A-Z][a-z]+)(?![\p{L}])/uy;
const NAMED_AFTER_BEFORE =
  /(?:(?<!\p{L})(?:ул|пр|просп|пер|пл|наб|им|ст)\.|улиц\p{L}*|проспект\p{L}*|имени)[ \xa0]*$/iu;

// Column/field headers that follow «ФИО» in tables and forms.
const FIELD_WORDS = new Set(
  (
    "телефон тел адрес дата email почта паспорт снилс инн должность подпись отдел город пол возраст статус имя отчество " +
    "фамилия контакт контакты комментарий примечание роль номер сумма организация компания класс группа"
  ).split(" "),
);

interface Tok {
  s: number;
  e: number;
  t: string;
}

function titleCase(w: string): string {
  return w
    .split("-")
    .map((p) => (p ? p.charAt(0) + p.slice(1).toLowerCase() : p))
    .join("-");
}

/** Capitalized ("Иван", "Анна-Мария") or all caps (ИВАНОВ) → title-cased token, else null. */
function capitalized(w: string): string | null {
  const parts = w.split("-");
  for (const p of parts) {
    if (!/^\p{Lu}/u.test(p)) return null;
  }
  if (parts.every((p) => p.length === 1 || /^\p{Lu}\p{Ll}+$/u.test(p))) return w;
  if (w.length >= 3 && /^[\p{Lu}-]+$/u.test(w)) return titleCase(w);
  return null;
}

function firstName(w: string): { ambiguous: boolean; latin: boolean } | null {
  const { names } = nameDict();
  const key = fold(w);
  const hit = names.get(key);
  if (hit) return hit;
  if (!w.includes("-")) return null;
  // Double first names: every part must be a name.
  let ambiguous = true;
  let latin = true;
  for (const p of key.split("-")) {
    const h = names.get(p);
    if (!h) return null;
    ambiguous &&= h.ambiguous;
    latin &&= h.latin;
  }
  return { ambiguous, latin };
}

export function isSurname(w: string): boolean {
  const key = fold(w);
  if (NOT_SURNAME.has(key)) return false;
  if (CYR.test(w)) {
    if (nameDict().surnames.has(key)) return true;
    return w.split("-").every((p) => SURNAME_SUFFIX_CYR.test(p) && p.length >= 4);
  }
  return LAT.test(w) && w.length >= 4 && SURNAME_SUFFIX_LAT.test(w);
}

function isPatronymic(w: string): boolean {
  return CYR.test(w) ? PATRONYMIC_CYR.test(w) : PATRONYMIC_LAT.test(w);
}

function sameScript(a: string, b: string): boolean {
  return CYR.test(a) === CYR.test(b);
}

interface Span {
  s: number;
  e: number;
  c: Confidence;
  /** Latin script → person_name_latin. */
  l: boolean;
}

export function detectNames(text: string): Finding[] {
  const toks: Tok[] = [];
  for (const m of text.matchAll(CAP_WORD_RE)) toks.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
  const adjacent = (a: number, b: number): boolean => {
    const x = toks[a];
    const y = toks[b];
    if (!x || !y) return false;
    const gap = y.s - x.e;
    return gap >= 1 && gap <= 3 && /^[ \xa0\t]+$/.test(text.slice(x.e, y.s));
  };
  const cap = (i: number): string | null => {
    const t = toks[i];
    return t ? capitalized(t.t) : null;
  };
  const { names } = nameDict();
  const spans: Span[] = [];

  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i] as Tok;
    if (tok.t.length === 1) {
      // "И. О. Фамилия" / "И. Фамилия"
      if (text.charCodeAt(tok.e) !== 46) continue;
      INITIALS_BEFORE_RE.lastIndex = tok.s;
      const m = INITIALS_BEFORE_RE.exec(text);
      if (m && isSurname(m[3] ?? "") && sameScript(m[3] ?? "", m[1] ?? "")) {
        spans.push({ s: tok.s, e: tok.s + m[0].length, c: "high", l: LAT.test(m[3] ?? "") });
      }
      continue;
    }
    // "Фамилия И. О."
    INITIALS_AFTER_RE.lastIndex = tok.e;
    const ia = INITIALS_AFTER_RE.exec(text);
    if (ia) {
      const sur = capitalized(tok.t);
      if (
        sur &&
        isSurname(sur) &&
        !firstName(sur) &&
        sameScript(sur, ia[1] ?? "") &&
        (!ia[2] || sameScript(sur, ia[2]))
      ) {
        spans.push({ s: tok.s, e: tok.e + ia[0].length, c: "high", l: LAT.test(sur) });
      }
    }
    // Dictionary first name as the anchor.
    if (!tok.t.includes("-") && !names.has(fold(tok.t))) continue;
    const w = capitalized(tok.t);
    if (!w) continue;
    const info = firstName(w);
    if (!info) continue;
    let s = i;
    let e = i;
    let ext = false;
    const r1 = cap(i + 1);
    if (r1 && adjacent(i, i + 1) && sameScript(w, r1)) {
      if (isPatronymic(r1)) {
        e = i + 1;
        ext = true;
        const r2 = cap(i + 2);
        if (r2 && adjacent(i + 1, i + 2) && sameScript(w, r2) && isSurname(r2) && !firstName(r2)) e = i + 2;
      } else if (isSurname(r1) && !firstName(r1)) {
        e = i + 1;
        ext = true;
      }
    }
    const l1 = cap(i - 1);
    if (l1 && adjacent(i - 1, i) && sameScript(w, l1) && isSurname(l1) && !firstName(l1)) {
      s = i - 1;
      ext = true;
    }
    const startTok = toks[s] as Tok;
    const before = text.slice(Math.max(0, startTok.s - 40), startTok.s);
    if (!ext) {
      if (info.ambiguous || info.latin) continue;
      if (STREET_BEFORE.test(before)) continue;
      if (LOCATION_NAMES.has(fold(w)) && LOCATION_PREP.test(before)) continue;
    } else if (NAMED_AFTER_BEFORE.test(before)) {
      continue; // street or institution named after a person: covered by address, not a data subject
    }
    spans.push({ s: startTok.s, e: (toks[e] as Tok).e, c: ext ? "high" : "medium", l: !CYR.test(w) });
    i = e;
  }

  for (const m of text.matchAll(FIO_LABEL_RE)) {
    const group = m[1] ?? "";
    const base = m.index + m[0].length - group.length;
    let end = -1;
    for (const w of group.matchAll(WORD_RE)) {
      if (FIELD_WORDS.has(fold(w[0]))) break;
      end = base + w.index + w[0].length;
    }
    if (end > base) spans.push({ s: base, e: end, c: "high", l: false });
  }

  // Union of overlapping spans.
  spans.sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Finding[] = [];
  let cur: Span | null = null;
  for (const sp of spans) {
    if (cur && sp.s <= cur.e) {
      if (sp.e > cur.e) cur.e = sp.e;
      if (sp.c === "high") cur.c = "high";
      continue;
    }
    if (cur) out.push(finding(cur.l ? "person_name_latin" : "person_name", cur.s, cur.e, cur.c));
    cur = { ...sp };
  }
  if (cur) out.push(finding(cur.l ? "person_name_latin" : "person_name", cur.s, cur.e, cur.c));
  return out;
}
