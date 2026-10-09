// Copy of the skeleton without a model (V3-18): the first screen's heading and lead, the label of the main action and
// the headings of the module forms, from the brief — the niche its keywords give, the place it names («в Казани»),
// the services it lists, the visitor's goals and scenarios said to the visitor («Выберите тур и оставьте заявку на
// заезд»), the button it quotes («Обсудить проект»), the system name. Plain rules, Russian, nothing invented (D49):
// never the audience as a heading, never the first words of a sentence cut off (the planner's niche of an unknown
// business), never the planner's placeholders (a heading equal to the niche, «Связаться»).
import type { BriefScenario, SystemBrief } from "@wizard/appspec";

/** Texts of the skeleton the brief gives. */
export interface BriefCopy {
  /** Heading of the first screen (≤ 90): what the business offers and where, else «<name> — <niche>», else the name. */
  title: string;
  /** Lead of the first screen (≤ 260): the services the brief lists, else the visitor's action said to him. */
  lead?: string;
  /** The button the brief quotes for a request («Обсудить проект»), ≤ 40. */
  action?: string;
  /** Heading of the request form: the quoted button, else «Заявка на <что>». */
  leadForm?: string;
  /** Heading of the booking form («Запись к врачам онлайн на свободное время»). */
  booking?: string;
  /** What the business is, in lower case, for the SEO title of the home page («медицинская клиника в Казани»). */
  about: string;
}

export interface CopyInput {
  name: string;
  /** The plan's niche and whether its keywords gave it (else it is the first words of the brief, not a phrase). */
  niche: string;
  keywordNiche: boolean;
  brief: Pick<SystemBrief, "audience" | "goals" | "scenarios">;
}

const LIMITS = { title: 90, lead: 260, action: 40, form: 80 } as const;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** «а, б, в» → «а, б и в». */
const listOf = (xs: readonly string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} и ${xs[xs.length - 1]}`;

/** The visitor's 3rd-person verbs (singular and plural) said to him: «оставляет» → «оставьте». */
const IMPERATIVE: Readonly<Record<string, string>> = {
  оставляет: "оставьте",
  оставляют: "оставьте",
  выбирает: "выберите",
  выбирают: "выберите",
  записывается: "запишитесь",
  записываются: "запишитесь",
  смотрит: "посмотрите",
  смотрят: "посмотрите",
  читает: "читайте",
  читают: "читайте",
  заказывает: "закажите",
  заказывают: "закажите",
  покупает: "купите",
  покупают: "купите",
  бронирует: "забронируйте",
  бронируют: "забронируйте",
  узнаёт: "узнайте",
  узнает: "узнайте",
  узнают: "узнайте",
  получает: "получите",
  получают: "получите",
  отправляет: "отправьте",
  отправляют: "отправьте",
  звонит: "позвоните",
  звонят: "позвоните",
  пишет: "напишите",
  пишут: "напишите",
  находит: "найдите",
  находят: "найдите",
  регистрируется: "зарегистрируйтесь",
  регистрируются: "зарегистрируйтесь",
  подписывается: "подпишитесь",
  подписываются: "подпишитесь",
  приходит: "приходите",
  приходят: "приходите",
  оплачивает: "оплатите",
  оплачивают: "оплатите",
};

/** Site mechanics at the end of a visitor's action: not said to him on the site itself. */
const SITE_TAIL = /\s+(?:с любой страницы сайта|на любой странице сайта|на сайте|с сайта|через сайт)$/i;

const PUBLIC_ACTORS: ReadonlySet<string> = new Set(["visitor", "client"]);

/**
 * A visitor's action said to him: «Посетитель выбирает тур и оставляет заявку на заезд» → «Выберите тур и оставьте
 * заявку на заезд». The first word is the verb, or the subject followed by the verb; every known verb of the clause
 * turns into the imperative. null — the sentence is not a visitor's action (an internal goal of the owner).
 */
export function toVisitor(sentence: string): string | null {
  const s = clean(sentence)
    .replace(/[.!]+$/, "")
    .replace(/^когда\s+/i, "");
  const words = s.split(" ");
  const verbAt = IMPERATIVE[low(words[0] ?? "")] ? 0 : IMPERATIVE[low(words[1] ?? "")] ? 1 : -1;
  if (verbAt < 0) return null;
  // Clauses joined by «и» or a comma: each that starts with a known verb is said to the visitor; the sentence ends
  // before the first one that does not («…и сами видят, что с ней» stays out — never half a sentence in the 3rd person).
  const clauses = words
    .slice(verbAt)
    .join(" ")
    .split(/(\s+и\s+|,\s+)/);
  const out: string[] = [];
  for (let i = 0; i < clauses.length; i += 2) {
    const clause = clauses[i] ?? "";
    const first = clause.split(" ")[0] ?? "";
    if (i > 0 && !IMPERATIVE[low(first)]) break;
    if (i > 0) out.push(clauses[i - 1] ?? " ");
    out.push(
      clause
        .split(" ")
        .map((w) => IMPERATIVE[low(w)] ?? w)
        .join(" "),
    );
  }
  return cap(out.join("").replace(SITE_TAIL, ""));
}

/** The first place the brief names: «в Казани», «по Карелии» (a preposition and a capitalised name). */
export function placeOf(texts: readonly string[]): string | undefined {
  const re = /(?:^|[\s,(«])([ВвПп]о?)\s+([А-ЯЁ][а-яё]+(?:-[А-ЯЁ]?[а-яё]+)?)(?=$|[\s,.;:)»])/u;
  for (const t of texts) {
    const m = re.exec(t);
    if (m) return `${(m[1] as string).toLowerCase()} ${m[2]}`;
  }
  return undefined;
}

/** «показывает услуги: дизайн квартиры, дизайн дома, авторский надзор, комплектация» → the listed services. */
export function listedServices(steps: readonly string[]): string[] | null {
  for (const step of steps) {
    const m = /^показыва\S*\s+[^:]{1,40}:\s*(.+)$/i.exec(clean(step));
    if (!m) continue;
    const items = (m[1] as string)
      .replace(/[.]$/, "")
      .split(/,\s*|\s+и\s+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (items.length >= 2 && items.length <= 8 && items.every((x) => x.length <= 60)) return items;
  }
  return null;
}

/** Generic words of a list that say nothing about the offer. */
const GENERIC = /^(?:услуг|товар|позици|цен|каталог|список|прайс|вариант|предложени)/i;

/**
 * What a catalog shows, as a noun: «показывает туры с ценой и длительностью» → «туры» (the head before «с», «:»,
 * «,»); null for generic words («услуги с ценами»).
 */
export function catalogNoun(steps: readonly string[]): string | null {
  for (const step of steps) {
    const m = /^показыва\S*\s+(.+)$/i.exec(clean(step));
    if (!m) continue;
    const head = (m[1] as string).split(/\s+(?:с|со|по|для|от|в)\s+|[:,«(]/)[0]?.trim() ?? "";
    if (!head || GENERIC.test(head) || head.split(" ").length > 3) continue;
    return head;
  }
  return null;
}

/** A button the brief quotes («Обсудить проект»): an infinitive first, ≤ 40 characters. */
export function quotedAction(texts: readonly string[]): string | undefined {
  for (const t of texts)
    for (const m of t.matchAll(/«([^«»]{3,40})»/g)) {
      const label = (m[1] as string).trim();
      if (/^[А-ЯЁ][а-яё]*(?:ть|ться|ти)(?:\s|$)/u.test(label)) return label;
    }
  return undefined;
}

/** «оставляет заявку на уборку на сайте» → «уборку»: what a request is for. */
function requestFor(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    const m = /заявк[уаи]\s+на\s+([^,.;«»]+)/i.exec(clean(t).replace(SITE_TAIL, ""));
    const what = m?.[1]?.replace(SITE_TAIL, "").trim();
    if (what && what.split(" ").length <= 4) return what;
  }
  return undefined;
}

/** «Пациенты записываются к врачам онлайн на свободное время» → «Запись к врачам онлайн на свободное время». */
function bookingOf(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    const m = /записыва\S*\s+((?:к|на|в)\s+[^,.;]+)/i.exec(clean(t).replace(SITE_TAIL, ""));
    const what = m?.[1]?.trim();
    if (what) {
      const out = `Запись ${what}`;
      if (out.length <= LIMITS.form) return out;
    }
  }
  return undefined;
}

const scenarioTexts = (scenarios: readonly BriefScenario[]) => scenarios.flatMap((s) => [s.when, ...s.then]);

/** The skeleton's texts of a brief (deterministic: the same brief gives the same texts). */
export function briefCopy(input: CopyInput): BriefCopy {
  const { brief } = input;
  const name = clean(input.name);
  const visitor = brief.scenarios.filter((s) => PUBLIC_ACTORS.has(s.actor));
  const goals = brief.goals.map((g) => g.text);
  const visitorTexts = [...goals, ...scenarioTexts(visitor)];
  const place = placeOf([brief.audience, ...goals, ...scenarioTexts(brief.scenarios)]);
  const catalog = visitor.filter((s) => s.moduleHint === "catalog" || /каталог|услуг|цен/i.test(s.when));
  const steps = catalog.flatMap((s) => s.then);

  // What the business is: the keywords' niche, else what its catalog shows («Туры»); with the place it names
  // («Туры по Карелии»), else after the name («Белая линия — стоматологическая клиника»).
  const noun = input.keywordNiche ? input.niche : catalogNoun(steps);
  const subject = noun ? `${noun}${place ? ` ${place}` : ""}` : null;
  let title =
    noun && place ? cap(`${noun} ${place}`) : noun ? (name ? `${name} — ${noun}` : cap(noun)) : name;
  if (title.length > LIMITS.title) title = name.slice(0, LIMITS.title);

  const services = listedServices(steps);
  const action = visitorTexts.map(toVisitor).find((x): x is string => !!x);
  let lead = services ? `${cap(listOf(services))}.` : action ? `${action}.` : undefined;
  if (lead && (lead.length > LIMITS.lead || lead.toLowerCase() === `${title.toLowerCase()}.`))
    lead = undefined;

  const button = quotedAction(visitorTexts);
  const request = requestFor(visitorTexts);
  const leadForm = button ?? (request ? `Заявка на ${request}` : undefined);
  const booking = bookingOf(visitorTexts);
  return {
    title,
    ...(lead ? { lead } : {}),
    ...(button ? { action: button } : {}),
    ...(leadForm && leadForm.length <= LIMITS.form ? { leadForm } : {}),
    ...(booking ? { booking } : {}),
    about: subject ? low(subject) : input.keywordNiche ? input.niche : name,
  };
}
