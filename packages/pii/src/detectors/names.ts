// person_name / person_name_latin (data-boundary.yaml#detectors.kinds): dictionary first names + capitalization, extended by
// adjacent patronymics/surnames; "Фамилия И. О." and "И. О. Фамилия"; values after «ФИО:».
import { type NameInfo, nameDict } from "../dict.js";
import type { Confidence, Finding } from "../types.js";
import { finding, nameKey } from "../util.js";

const WORD_RE = /\p{L}+(?:-\p{L}+)*/gu;
// Only capitalized words can be part of a name; adjacency is checked on the text between them.
// FU-2: "O'Neil", "D’Angelo" are one token.
const CAP_WORD_RE = /(?<!\p{L})(?:\p{Lu}['’](?=\p{Lu}))?\p{Lu}\p{L}*(?:-\p{L}+)*/gu;
const CYR = /^[\p{Script=Cyrillic}-]+$/u;
const LAT = /^[\p{Script=Latin}'’-]+$/u;
// FU-2: one capitalized part of a name, incl. "McGregor", "MacArthur", "O'Neil", "DeLuca".
const NAME_PART = /^(?:Mc|Mac|Fitz|De|Di|Le|La|Du|Van|Von|\p{Lu}['’])?\p{Lu}\p{Ll}+$/u;
// FU-2: lowercase particles of Latin names between two capitalized parts ("van der Berg", "da Silva", "al-Rashid").
const PARTICLE_GAP =
  /^[ \xa0]+(?:(?:van|von|der|den|de|del|della|degli|di|da|das|dos|do|du|la|le|ter|ten|bin|ibn|bint|abu|y|zu)[ \xa0]+){0,3}(?:(?:al|el|ad|ar|as|ash|at|an|az|ul|ud)-)?$/;

const PATRONYMIC_CYR =
  /^[А-ЯЁ][а-яё]+(?:(?:ович|евич|ьич|ич)(?:а|у|ем|ом|е)?|(?:овн|евн|ичн|иничн)(?:а|ы|е|у|ой|ою))$/u;
const PATRONYMIC_LAT = /^[A-Z][a-z]+(?:ovich|evich|ovna|evna|ichna|yich)$/;
export const SURNAME_SUFFIX_CYR =
  /^[А-ЯЁ][а-яё]+(?:(?:ов|ев|ёв|ин|ын)(?:а|у|ым|ом|е|ой|ы|ых|ыми)?|(?:ск|цк)(?:ий|ая|ой|ого|ому|им|ом|ую|ие|их)|енко|[ую]к(?:а|у|ом|е)?|янц?|швили|дзе|[ыи]х|[ое]вич(?:а|у|ем|ом|е)?)$/u;
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
// Words right before a standalone first name that make it the name of a place, street or venue (not a person).
const STREET_BEFORE =
  /(?:(?<!\p{L})(?:ул|пр|просп|пер|пл|наб|б-р|пр-т|пр-кт|ш|им|ст|м|г|пос|мкр|обл)\.?|улиц\p{L}*|проспект\p{L}*|переул\p{L}*|площад\p{L}*|бульвар\p{L}*|набережн\p{L}*|шоссе|имени|памятник\p{L}*|станци\p{L}*|метро|город\p{L}*|район\p{L}*|област\p{L}*|посел\p{L}*|посёл\p{L}*|село|селе|селом|деревн\p{L}*|аэропорт\p{L}*|вокзал\p{L}*|театр\p{L}*|музе\p{L}*|школ\p{L}*|храм\p{L}*|собор\p{L}*|фестивал\p{L}*|форум\p{L}*|бренд\p{L}*|марк[аиуеой]{1,2}|компани\p{L}*|магазин\p{L}*|салон\p{L}*|кафе|ресторан\p{L}*|гостиниц\p{L}*|отел\p{L}*|студи\p{L}*|агентств\p{L}*|клиник\p{L}*|фирм\p{L}*|бар[аеуы]?|кинотеатр\p{L}*|ооо|оао|зао|пао)[ \xa0]*[«"„]?[ \xa0]*$/iu;
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

// FU-1 pair heuristic (dictionary first name or surname + an unknown Title-case word): words that are not given names
// or surnames even when capitalized — function words, roles and titles, places and organisations, dates.
const PAIR_STOP = new Set(
  (
    "а без в во вот все всё вы да для до его её ее если есть ещё еще же за здесь и из или им их к как когда кто ли " +
    "либо мы на над не нет ни но ну о об он она они оно от по под при про с со так там тем то тоже только ты тут у уже " +
    "чем что чтобы эта эти это этот я где куда почему зачем сегодня завтра вчера сейчас потом тогда также очень просто " +
    "можно нужно надо хорошо спасибо пожалуйста привет пока ок окей добрый доброе доброго здравствуйте здравствуй " +
    "москва москве москву москвы питер питере петербург казань самара екатеринбург новосибирск сочи россия россии рф " +
    "январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь понедельник вторник среда четверг " +
    "пятница суббота воскресенье брат брата брату сын сына сыну дочь дочери жена жены жене муж мужа мужу друг друга " +
    "другу мама маме мамы маму папа папе папы папу дядя дяди тётя тёти тетя тети мисс сэр мэр мэра мэру мэре парк парка " +
    "парке парку гора горы горе озеро озера река реки мост моста село села край края краю крае метро имени тур тура " +
    "mr mrs ms miss dr prof sir madam mister dear hi hello hey thanks thank regards best cheers sincerely yours agent " +
    "officer captain detective doctor president senator professor judge king queen prince princess lord lady saint st " +
    "san santa mount mt lake fort port cape new north south east west upper lower old big little great grand the an " +
    "and or but of in on at to from by with for about team project product company group inc ltd llc corp co plc gmbh " +
    "street avenue ave road rd lane drive boulevard blvd square place way court park station center centre mall plaza " +
    "tower building hall house home hotel hostel resort airport airlines airways university college school academy " +
    "institute hospital clinic museum gallery theatre theater studio studios store shop market cafe restaurant bar pub " +
    "club bank foundation fund trust capital partners holdings systems solutions services consulting software " +
    "technologies technology tech labs lab media news times post journal magazine radio music records films pictures " +
    "books press games sport sports fitness gym spa salon beauty design fashion style kitchen garden city county state " +
    "country island beach bay river valley hill mountain bridge day night week year month show festival cup award " +
    "awards prize edition collection series season episode chapter part version release pro plus max mini lite premium " +
    "standard basic free online app apps cloud code monday tuesday wednesday thursday friday saturday sunday january " +
    "february march april may june july august september october november december usa uk eu russia moscow london " +
    "paris berlin america american english russian german french please call email phone contact support admin user " +
    "manager director ceo cto cfo vp head lead senior junior intern customer client owner buyer seller visitor guest " +
    "member author editor reporter says said wrote writes controls motors airlines express bros brothers sons ооо оао " +
    "зао пао ип нко гбу муп фгуп"
  ).split(" "),
);
// Stems of place and organisation words (folded, prefix match): "Мадина Маркет" is a brand, not a person.
const PLACE_ORG_STEM =
  /^(?:улиц|проспект|переул|площад|бульвар|набережн|шоссе|сквер|станци|район|город|деревн|посел|област|республик|музе|театр|школ|гимнази|лице[йя]|университет|институт|академи|библиотек|больниц|поликлиник|клиник|завод|фабрик|компани|банк|магазин|кафе|ресторан|отел[ьяюе]|гостиниц|аэропорт|вокзал|преми|приз|куб[оа]к|орден|медал|фонд|центр|клуб|фестивал|конкурс|турнир|памятник|остров|залив|групп|холдинг|сервис|маркет|плаза|сити|холл|трейд|строй|моторс|экспресс|студи|салон|шоп|стиль|авто|дизайн|мебел|фитнес|спорт|медиа|плюс)/u;
// Stems of role, title and greeting words (folded, prefix match).
const ROLE_STEM =
  /^(?:клиент|сотрудни|пациент|директор|менеджер|врач|доктор|господ|госпож|товарищ|уважаем|коллег|студент|учител|ученик|автор|заказчи|получател|отправител|водител|курьер|мастер|тренер|руководител|администратор|оператор|покупател|продав|владел|участни|пользовател|абонент|граждан|мистер|миссис|бабушк|дедушк|сестр|подруг|сосед|профессор|академик|генерал|маршал|полковник|майор|капитан|лейтенант|сержант|президент|министр|губернатор|депутат|сенатор|судь|прокурор|следовател|адвокат|нотариус|инженер|бухгалтер|юрист|специалист|эксперт|консультант|агент|партнер|представител|кандидат|преподавател|воспитател|заведующ|начальни|заместител|шеф|инспектор|писател|поэт|художни|композитор|актер|актрис|певец|певиц|режиссер|цар[ья]|корол|княз|граф|барон|свят[аоыу]|дорог[аоиу]|здравству|привет|спасиб|добр[оы])/u;
// Unknown Cyrillic words that decline like nouns or adjectives rather than names.
const NOUN_LIKE_CYR =
  /(?:ость|ости|остью|ств[оауеы]|ством|ни[еяюй]|нием|ци[яиюей]|тел[ьяюие]|телем|ое|ые|ого|ому|ыми|ими|ую)$/u;
const VERB_LIKE_CYR = /(?:[иы]те|йте|ать|ять|ить|еть|уть|ться|тся|лся|лась|лись|ешь|ишь)$/u;
const ADJ_LIKE_CYR = /(?:ый|ий|ой|ая|яя|ее|ей)$/u;
const NOUN_LIKE_LAT = /(?:tion|sion|ment|ness|ship|ware|able|ible|ology|ics|ies)$/;
const TITLE_WORD =
  /^(?:Mc|Mac|Fitz|De|Di|Le|La|Du|Van|Von|\p{Lu}['’])?\p{Lu}\p{Ll}+(?:-(?:Mc|Mac|\p{Lu}['’])?\p{Lu}\p{Ll}+)*$/u;
// FU-2: Latin brands, products, tech terms and places that are never a person's name, even after a role word.
const TECH_STOP = new Set(
  (
    "google sheets docs drive maps gmail chrome android microsoft windows office excel powerpoint outlook teams skype " +
    "visual studio basic react native vue angular svelte next nuxt node deno nest spring boot django flask rails " +
    "python java javascript typescript kotlin golang php laravel symfony docker kubernetes linux ubuntu debian apple " +
    "iphone ipad macbook mac ios macos safari firefox mozilla opera edge amazon aws web azure oracle sap salesforce " +
    "hubspot notion slack jira confluence trello asana figma sketch adobe photoshop illustrator premiere acrobat zoom " +
    "meet telegram whatsapp viber signal discord vkontakte yandex ozon wildberries avito sber sberbank tinkoff alfa " +
    "bitrix amocrm tilda wix shopify wordpress woocommerce magento github gitlab bitbucket postgres postgresql mysql " +
    "mongo mongodb redis kafka rabbitmq elastic grafana prometheus unity unreal engine blender autocad revit world " +
    "york jersey angeles francisco hong kong vegas tesla spacex netflix spotify youtube tiktok instagram facebook " +
    "twitter meta openai chatgpt claude gemini copilot power tableau looker data base machine learning deep source " +
    "stack overflow smart digital global mobile desktop site landing page form forms table tables sheet note notes " +
    "pay wallet card cards money marketplace delivery food taxi go travel booking air lines platinum gold silver " +
    "black white red blue green yellow orange pink purple love life time coffee like good top first one happy fresh " +
    "starter kit ultra sale black friday cyber monday christmas halloween valentine easter merry happy birthday " +
    "welcome login logout sign dashboard settings profile account order orders cart checkout invoice payment report " +
    "reports analytics export import upload download admin panel console terminal server client framework library " +
    "module component widget plugin template theme bot bots chat messenger mail inbox calendar tasks task board " +
    "kanban sprint scrum agile lean six sigma quality control assurance hello coca cola pepsi nike adidas puma " +
    "samsung xiaomi huawei lenovo sony canon nikon toyota honda nissan mazda hyundai kia volkswagen audi bmw " +
    "mercedes porsche ferrari lamborghini lexus volvo skoda renault peugeot citroen fiat jeep chevrolet cadillac " +
    "starbucks mcdonalds burger ikea zara uniqlo lego disney marvel pixar warner universal paramount"
  ).split(" "),
);
// FU-2: role, position or introduction right before a Title-case Latin pair makes it a person's name
// («помощник финдиректора Hiroshi Tanaka-Weller», «меня зовут Kwame Mensah», «CEO Aiko Tanabe»).
const ROLE_CTX =
  /(?:(?<!\p{L})(?:(?:фин|ген|тех|зам|арт|коммерческ\p{L}*[ \xa0]+|исполнительн\p{L}*[ \xa0]+)?директор|менеджер|помощни[кц]|ассистент|бухгалтер|главбух|руководител|начальни|заместител|координатор|администратор|секретар|юрист|инженер|разработчи|программист|дизайнер|аналитик|специалист|консультант|куратор|организатор|владел|основател|сооснователь|сотрудни|коллег|партн[её]р|представител|закупщи|снабжен|кладовщи|продав|кассир|курьер|водител|спикер|докладчи|тренер|преподавател|врач|клиент|заказчи|подрядчи|собственни|президент|председател|участни|кандидат|соискател|рекрутер|получател|отправител|ответственн|контактн\p{L}*[ \xa0]+лиц|контакт)\p{L}*|(?<!\p{L})(?:зовут|звать|имя|гост(?:ь|я|ю|ем|и|ей))|(?<![\p{L}-])(?:ceo|cto|cfo|coo|cmo|cio|founder|co-founder|cofounder|manager|director|assistant|accountant|engineer|developer|designer|analyst|consultant|coordinator|officer|lead|head|owner|contact|speaker|chairman|president|secretary|recruiter|supervisor|vp|named|name is|dear|mr|mrs|ms|dr|prof))\.?(?:[ \xa0]*[:—–-])?[ \xa0]+$/iu;
const ALL_CAPS = /^[\p{Lu}-]+$/u;

// M1-07: lone surname in the genitive (or feminine nominative) after a head word — sheet names and headers like
// «Клиенты Рахимова», «Заказы Ивановой». -ова/-ева by shape; -ина/-ына, -овой/-евой and -ского/-ской by dictionary only.
const LONE_GEN_OV = /^(\p{L}{3,}?)(?:ов|ев)а$/u;
const LONE_GEN_DICT = /^\p{L}{2,}(?:(?:ов|ев|ин|ын)(?:а|ой)|(?:ск|цк)(?:ого|ой))$/u;
const LONE_HEAD_BEFORE = /(?<!\p{L})(\p{Script=Cyrillic}{2,})[ \xa0\t_]{1,3}$/u;
// Genitives of cities and common nouns/adjectives that decline like a surname in -ова/-ева.
const LONE_STOP = new Set(
  (
    "ростова саратова кирова пскова тамбова азова серпухова дмитрова реутова чехова " +
    "острова покрова основа корова подкова обнова готова здорова сурова дешева дерева посева нагрева прогрева " +
    "разогрева перегрева обогрева припева напева норова"
  ).split(" "),
);
const surnameBase = (key: string): string =>
  key.replace(/(?:ск|цк)(?:ого|ой)$/, (m) => `${m.slice(0, 2)}ий`).replace(/(?:а|ой)$/, "");

function loneGenitiveSurname(w: string): boolean {
  if (!CYR.test(w) || w.includes("-")) return false;
  const key = nameKey(w);
  const { names, surnames, strongSurnames } = nameDict();
  if (names.has(key) || LONE_STOP.has(key)) return false;
  // Weak dictionary surnames are common words (Королева, Мороза).
  if (surnames.has(key) && !strongSurnames.has(key)) return false;
  if (LONE_GEN_DICT.test(key) && (strongSurnames.has(key) || strongSurnames.has(surnameBase(key))))
    return true;
  return LONE_GEN_OV.test(key) && !NOUN_LIKE_CYR.test(key);
}

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
  // FU-2: Korean given names spelled "Min-jun" (dictionary forms only).
  if (/^\p{Lu}\p{Ll}+(?:-\p{Ll}+)+$/u.test(w) && nameDict().names.has(nameKey(w))) return w;
  const parts = w.split("-");
  for (const p of parts) {
    if (!/^\p{Lu}/u.test(p)) return null;
  }
  if (parts.every((p) => p.length === 1 || NAME_PART.test(p))) return w;
  if (w.length >= 3 && /^[\p{Lu}-]+$/u.test(w)) return titleCase(w);
  return null;
}

function firstName(w: string): NameInfo | null {
  const { names } = nameDict();
  const key = nameKey(w);
  const hit = names.get(key);
  if (hit) return hit;
  if (!w.includes("-")) return null;
  // Double first names: every part must be a name.
  let ambiguous = true;
  let latin = true;
  let word = true;
  for (const p of key.split("-")) {
    const h = names.get(p);
    if (!h) return null;
    ambiguous &&= h.ambiguous;
    latin &&= h.latin;
    word &&= h.word;
  }
  return { ambiguous, latin, word };
}

export function isSurname(w: string): boolean {
  const key = nameKey(w);
  if (NOT_SURNAME.has(key)) return false;
  if (CYR.test(w)) {
    if (nameDict().surnames.has(key)) return true;
    return w.split("-").every((p) => SURNAME_SUFFIX_CYR.test(p) && p.length >= 4);
  }
  if (!LAT.test(w)) return false;
  return (w.length >= 4 && SURNAME_SUFFIX_LAT.test(w)) || strongLatinSurname(key);
}

/** Strong dictionary surname; FU-2: also a hyphenated Latin one with a strong part ("Smith-Jones"). */
function strongLatinSurname(key: string): boolean {
  const { strongSurnames } = nameDict();
  if (strongSurnames.has(key)) return true;
  if (!key.includes("-") || !LAT.test(key)) return false;
  const parts = key.split("-");
  return parts.every((p) => p.length >= 2) && parts.some((p) => strongSurnames.has(p));
}

/** FU-2: Title-case Latin word that may be part of a person's name next to a role word (not a brand or tech term). */
function latinNamePart(raw: string): boolean {
  if (!TITLE_WORD.test(raw) || !LAT.test(raw)) return false;
  const key = nameKey(raw);
  if (NOUN_LIKE_LAT.test(key)) return false;
  return key.split("-").every((p) => !PAIR_STOP.has(p) && !TECH_STOP.has(p));
}

/** Capitalized place or organisation word ("Маркет", "Центр"): a first name right before it names a brand. */
function placeOrOrg(raw: string): boolean {
  return CYR.test(raw) && PLACE_ORG_STEM.test(nameKey(raw));
}

/**
 * FU-1: can the unknown token `raw` stand next to the dictionary name/surname `anchor` as the other half of a person's
 * name? `given` — it would be the given name (next to a surname), else the surname (next to a given name).
 */
function pairable(raw: string, anchor: string, given: boolean): boolean {
  if (ALL_CAPS.test(anchor) && anchor.length > 1) {
    if (raw.length < 3 || !ALL_CAPS.test(raw)) return false;
  } else if (!TITLE_WORD.test(raw)) return false;
  const w = capitalized(raw);
  if (!w || w.length < 3 || !sameScript(w, anchor)) return false;
  const key = nameKey(w);
  if (PAIR_STOP.has(key)) return false;
  if (CYR.test(w)) {
    if (ROLE_STEM.test(key) || PLACE_ORG_STEM.test(key)) return false;
    if (NOUN_LIKE_CYR.test(key) || VERB_LIKE_CYR.test(key)) return false;
    if (given && ADJ_LIKE_CYR.test(key)) return false;
    return true;
  }
  return LAT.test(w) && !NOUN_LIKE_LAT.test(key) && !TECH_STOP.has(key);
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
    if (gap >= 1 && gap <= 3 && /^[ \xa0\t]+$/.test(text.slice(x.e, y.s))) return true;
    return gap > 2 && gap <= 24 && LAT.test(x.t) && LAT.test(y.t) && PARTICLE_GAP.test(text.slice(x.e, y.s));
  };
  const cap = (i: number): string | null => {
    const t = toks[i];
    return t ? capitalized(t.t) : null;
  };
  const { names, surnames } = nameDict();
  const spans: Span[] = [];
  const beforeTok = (k: number): string => {
    const t = toks[k] as Tok;
    return text.slice(Math.max(0, t.s - 40), t.s);
  };
  // FU-1: strong dictionary surname + an unknown name-like word ("Рахимов Джахонгир", "Smith Johnny").
  const surnamePair = (i: number, w: string): { span: Span; end: number } | null => {
    if (CYR.test(w) ? !nameDict().strongSurnames.has(nameKey(w)) : !strongLatinSurname(nameKey(w)))
      return null;
    const raw = (toks[i] as Tok).t;
    const givenOk = (j: number): boolean => {
      const t = toks[j];
      const g = t ? capitalized(t.t) : null;
      if (!t || !g || !sameScript(g, w)) return false;
      if (firstName(g)) return true;
      return !isSurname(g) && pairable(t.t, raw, true);
    };
    let s = i;
    let e = i;
    if (adjacent(i, i + 1) && givenOk(i + 1)) {
      e = i + 1;
      const p = cap(i + 2);
      if (p && adjacent(i + 1, i + 2) && sameScript(w, p) && isPatronymic(p)) e = i + 2;
    } else if (adjacent(i - 1, i) && givenOk(i - 1)) s = i - 1;
    else return null;
    const before = beforeTok(s);
    if (STREET_BEFORE.test(before) || NAMED_AFTER_BEFORE.test(before)) return null;
    return { span: { s: (toks[s] as Tok).s, e: (toks[e] as Tok).e, c: "high", l: !CYR.test(w) }, end: e };
  };

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
    // FU-2: role or introduction + Title-case Latin pair (or triple).
    if (adjacent(i, i + 1) && latinNamePart(tok.t) && latinNamePart((toks[i + 1] as Tok).t)) {
      if (ROLE_CTX.test(beforeTok(i))) {
        let e = i + 1;
        if (adjacent(e, e + 1) && latinNamePart((toks[e + 1] as Tok).t)) e++;
        spans.push({ s: tok.s, e: (toks[e] as Tok).e, c: "high", l: true });
        i = e;
        continue;
      }
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
    // M1-07: «Клиенты Рахимова», «Заказы Ивановой» (not «Проспект Сахарова», «из Ростова», «Премия Кандинского»).
    {
      const w = capitalized(tok.t);
      const before = beforeTok(i);
      const head = LONE_HEAD_BEFORE.exec(before)?.[1];
      if (
        w &&
        head &&
        loneGenitiveSurname(w) &&
        !PLACE_ORG_STEM.test(nameKey(head)) &&
        !STREET_BEFORE.test(before) &&
        !NAMED_AFTER_BEFORE.test(before) &&
        !LOCATION_PREP.test(before)
      )
        spans.push({ s: tok.s, e: tok.e, c: "medium", l: false });
    }
    // Dictionary first name as the anchor; otherwise a strong dictionary surname.
    const key = nameKey(tok.t);
    const nameLike = tok.t.includes("-") || names.has(key);
    if (!nameLike && !nameDict().strongSurnames.has(key)) continue;
    const w = capitalized(tok.t);
    if (!w) continue;
    const info = nameLike ? firstName(w) : null;
    if (!info) {
      const pair = surnamePair(i, w);
      if (pair) {
        spans.push(pair.span);
        i = pair.end;
      }
      continue;
    }
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
    // FU-2: Latin surname-first order with any dictionary surname ("Park Ji-hoon", "Tanaka Hiroshi").
    const lat = !CYR.test(w);
    if (!ext && !info.word && lat && l1 && adjacent(i - 1, i) && surnames.has(nameKey(l1))) {
      s = i - 1;
      ext = true;
    }
    // FU-1: a first name that is not a common word + an unknown name-like word ("Джахонгир Турдыбек", "John Smithers").
    let pair = false;
    if (!ext && !info.word && adjacent(i, i + 1) && pairable((toks[i + 1] as Tok).t, tok.t, false)) {
      e = i + 1;
      ext = pair = true;
    }
    // FU-2: second part of a Latin double surname ("Gabriel García Márquez").
    if (ext && lat && e > i) {
      const r = cap(e + 1);
      if (r && adjacent(e, e + 1) && LAT.test(r) && isSurname(r) && !firstName(r)) e++;
    }
    const startTok = toks[s] as Tok;
    const before = beforeTok(s);
    if (pair && STREET_BEFORE.test(before)) continue;
    if (!ext) {
      if (info.ambiguous || info.latin) continue;
      if (STREET_BEFORE.test(before)) continue;
      if (adjacent(i, i + 1) && placeOrOrg((toks[i + 1] as Tok).t)) continue; // "Мадина Маркет", "Тимур Центр"
      if (LOCATION_NAMES.has(nameKey(w)) && LOCATION_PREP.test(before)) continue;
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
      if (FIELD_WORDS.has(nameKey(w[0]))) break;
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
