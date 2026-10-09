// The owner's words → a refinement of the three directions, by code (V3-09; D77: algorithms ahead of models). A fixed
// lexicon of Russian adjectives and phrases gives tuning deltas; «как второй, но строже» / «у первого без фото» name
// the direction, «беру второй» picks it. Only a phrase the lexicon does not understand at all goes to the model.
import { type DirectionTuning, mergeTuning, normalizeTuning } from "./tuning.js";

interface LexRule {
  id: string;
  re: RegExp;
  delta: DirectionTuning;
}

// Matches start a word: (?<![а-яa-z0-9]) — «тепл» never matches inside another word.
const W = "(?<![а-яa-z0-9])";
const rx = (s: string) => new RegExp(`${W}(?:${s})`, "g");

/** Lexicon rules, the specific (multi-word) ones first: a matched span is not matched again. */
export const LEXICON: readonly LexRule[] = [
  // The exact words of tuningWords (the brief keeps them as «Пожелания словами»): one axis each, read back exactly.
  { id: "contrast_down", re: rx("мягче контраст\\S*"), delta: { contrast: -1 } },
  { id: "colour_calm", re: rx("спокойнее цвет\\S*"), delta: { saturation: -1 } },
  { id: "colour_bright", re: rx("ярче цвет\\S*"), delta: { saturation: 1 } },
  { id: "motion_calm", re: rx("спокойнее движени\\S*"), delta: { motion: -1 } },
  { id: "motion_lively", re: rx("живее движени\\S*"), delta: { motion: 1 } },
  {
    id: "no_photos",
    re: rx(
      "без (?:фото\\S*|картин\\S*|изображени\\S*|снимк\\S*|иллюстрац\\S*)|убери\\S* (?:фото\\S*|картин\\S*|изображени\\S*)|только текст\\S*|не надо (?:фото\\S*|картин\\S*)",
    ),
    delta: { photos: false },
  },
  {
    id: "photos",
    re: rx("(?:с|добав\\S*|больше|нужн\\S*|верни\\S*) (?:фото\\S*|картин\\S*|изображени\\S*|снимк\\S*)"),
    delta: { photos: true },
  },
  {
    id: "no_motion",
    re: rx("без (?:анимац\\S*|движени\\S*)|статичн\\S*|ничего не двига\\S*"),
    delta: { motion: -2 },
  },
  {
    id: "headline_up",
    re: rx(
      "(?:крупнее|больше|покрупнее) (?:заголов\\S*|шрифт\\S*|буквы|текст\\S*)|заголов\\S* (?:крупнее|больше|покрупнее)|крупн\\S* заголов\\S*|покрупнее|крупнее",
    ),
    delta: { scale: 1 },
  },
  {
    id: "headline_down",
    re: rx(
      "(?:мельче|меньше|поменьше|помельче) (?:заголов\\S*|шрифт\\S*|буквы)|заголов\\S* (?:мельче|меньше|поменьше|скромнее)|помельче|мельче",
    ),
    delta: { scale: -1 },
  },
  {
    id: "dark",
    re: rx(
      "темнее|потемнее|темн(?:ый|ая|ое|ом|ую) (?:фон\\S*|тем\\S*|вариант\\S*|сайт\\S*|стран\\S*)|ночн\\S*|черн(?:ый|ом) фон\\S*",
    ),
    delta: { scheme: "dark" },
  },
  {
    id: "light",
    re: rx(
      "светлее|посветлее|светл(?:ый|ая|ое|ом|ую) (?:фон\\S*|тем\\S*|вариант\\S*|сайт\\S*|стран\\S*)|бел(?:ый|ом) фон\\S*",
    ),
    delta: { scheme: "light" },
  },
  {
    id: "sharp",
    re: rx("острее|остр(?:ые|ыми) угл\\S*|прям(?:ые|ыми) угл\\S*|без скруглени\\S*|квадратн\\S*"),
    delta: { radius: -1 },
  },
  { id: "round", re: rx("кругл\\S*|скругл\\S*|округл\\S*|закругл\\S*"), delta: { radius: 1 } },
  {
    id: "airy",
    re: rx("просторн\\S*|больше (?:воздуха|места|пространства)|воздушн\\S*|свободн\\S*|пореже"),
    delta: { density: 1 },
  },
  {
    id: "dense",
    re: rx("плотн\\S*|компактн\\S*|теснее|меньше (?:воздуха|пустоты|пустого места)|кучнее"),
    delta: { density: -1 },
  },
  {
    id: "warm",
    re: rx("(?:по)?теплее|тепл(?:ый|ая|ое|ые|ых|ым|ую|ом|о)|уютн\\S*|теплых тон\\S*"),
    delta: { warmth: 1 },
  },
  {
    id: "cool",
    re: rx("(?:по)?холоднее|прохладн\\S*|холодн\\S*|свежее|свеж(?:ий|ая|ое)"),
    delta: { warmth: -1 },
  },
  {
    id: "strict",
    re: rx(
      "строже|построже|строг\\S*|серьезн\\S*|солидн\\S*|делов\\S*|официальн\\S*|сдержанн\\S*|минималистичн\\S*",
    ),
    delta: { contrast: 1, radius: -1, motion: -1 },
  },
  {
    id: "soft",
    re: rx("мягче|помягче|мягк\\S*|дружелюбн\\S*|нежн\\S*|душевн\\S*"),
    delta: { contrast: -1, radius: 1 },
  },
  { id: "contrast", re: rx("контрастн\\S*"), delta: { contrast: 1 } },
  {
    id: "calm",
    re: rx("спокойн\\S*|поспокойнее|тише|приглушенн\\S*|нейтральн\\S*|бледн\\S*|пастельн\\S*"),
    delta: { saturation: -1, motion: -1 },
  },
  {
    id: "bright",
    re: rx("ярче|поярче|ярк\\S*|сочн\\S*|насыщенн\\S*|смел\\S*|цветн\\S*"),
    delta: { saturation: 1 },
  },
  {
    id: "lively",
    re: rx("живее|жив(?:ой|ая|ое)|динамичн\\S*|больше (?:движения|анимации)|анимац\\S*"),
    delta: { motion: 1 },
  },
];

const ORDINALS: readonly [RegExp, 1 | 2 | 3][] = [
  [rx("перв\\S*|1-?(?:й|ый|ая|ое|ого|ому|ом)|(?:№|номер|вариант\\S*|направлени\\S*) ?1(?![0-9])"), 1],
  [rx("втор\\S*|2-?(?:й|ой|ая|ое|ого|ому|ом)|(?:№|номер|вариант\\S*|направлени\\S*) ?2(?![0-9])"), 2],
  [rx("трет\\S*|3-?(?:й|ий|ья|ье|его|ему|ем)|(?:№|номер|вариант\\S*|направлени\\S*) ?3(?![0-9])"), 3],
];

const NEGATION =
  /(?:^|\s)(?:не|менее|поменьше|без лишн\S*)(?:\s+(?:так|такой|такая|такое|слишком|очень|сильно))?\s*$/;
const STRONG = /(?:^|\s)(?:намного|гораздо|сильно|сильнее|очень|совсем|заметно)\s*$/;
const PICK_CUE = rx(
  "беру|берем|выбираю|выбираем|выбрал\\S*|оставля\\S*|оставь\\S*|остановимся|подходит|нравится|понравил\\S*|давай\\S*|возьм\\S*|годится|устраивает|согласен|согласна|этот",
);

/** Words the parser ignores when it looks for something it did not understand. */
const STOP = new Set(
  (
    "как но и а или да нет же ну вот так такой такая такое тоже еще ещё чуть чуть-чуть немного немножко слегка " +
    "капельку более менее очень сильно сильнее намного гораздо совсем заметно сделай сделайте сделать давай " +
    "давайте пожалуйста можно нужно надо хочу хотим хотелось бы был была было были будет пусть чтобы это этот " +
    "эта эти все всё весь вся там тут где мне нам нас вам вариант варианта варианте варианты направление " +
    "направления стиль стиле дизайн дизайна сайт сайта сайте оформление цвет цвета цвете тон тона общий общем " +
    "у в во на по с со к для из от до при то тот та те его ее её их он она оно они мы вы ты я лучше чем стал " +
    "стала стало стали поменяй поменяйте измени измените поправь поправьте покажи покажите вариантов " +
    "который которая которое и/или раз два три также плюс"
  ).split(/\s+/),
);

export interface ParsedRefinement {
  /** Deltas the words ask for. */
  tuning: DirectionTuning;
  /** Lexicon rules that matched (ids, in text order). */
  matched: string[];
  /** The direction the change is about (1–3); null — all three. */
  target: 1 | 2 | 3 | null;
  /** «беру второй» without changes — the owner picks this direction. */
  pick: 1 | 2 | 3 | null;
  /** Words the lexicon did not understand (lower case). */
  unknown: string[];
}

/** Lower case, ё → е, «-» and quotes as spaces, single spaces. */
export function normalizeWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"“”„()!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Span {
  start: number;
  end: number;
}
const overlaps = (spans: readonly Span[], s: Span) => spans.some((x) => s.start < x.end && x.start < s.end);

/** Parses the owner's words; never throws, never calls a model. */
export function parseRefinement(raw: string): ParsedRefinement {
  const text = normalizeWords(raw).slice(0, 500);
  const used: Span[] = [];
  const hits: { at: number; id: string; delta: DirectionTuning }[] = [];
  for (const rule of LEXICON) {
    for (const m of text.matchAll(rule.re)) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(used, span)) continue;
      used.push(span);
      const before = text.slice(Math.max(0, span.start - 24), span.start);
      let delta = rule.delta;
      if (NEGATION.test(before)) delta = invert(delta);
      if (STRONG.test(before)) delta = scaleDelta(delta, 2);
      hits.push({ at: span.start, id: rule.id, delta });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  let tuning: DirectionTuning = {};
  for (const h of hits) tuning = mergeTuning(tuning, h.delta);

  let target: ParsedRefinement["target"] = null;
  for (const [re, n] of ORDINALS) {
    for (const m of text.matchAll(re)) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(used, span)) continue;
      used.push(span);
      if (target === null) target = n;
    }
  }
  const pickCue = [...text.matchAll(PICK_CUE)];
  for (const m of pickCue) used.push({ start: m.index, end: m.index + m[0].length });
  // «беру второй», «второй», «как второй» without any change — a pick.
  const pick = hits.length === 0 && target !== null ? target : null;

  let rest = text;
  for (const s of [...used].sort((a, b) => b.start - a.start))
    rest = `${rest.slice(0, s.start)} ${rest.slice(s.end)}`;
  const unknown = rest
    .split(/[\s,.;:—–-]+/)
    .map((w) => w.replace(/[^а-яa-z0-9-]/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  return { tuning: normalizeTuning(tuning), matched: hits.map((h) => h.id), target, pick, unknown };
}

function invert(d: DirectionTuning): DirectionTuning {
  const out: DirectionTuning = {};
  for (const [k, v] of Object.entries(d) as [keyof DirectionTuning, unknown][]) {
    if (typeof v === "number") (out as Record<string, number>)[k] = -v;
    else if (k === "photos") out.photos = !(v as boolean);
    else if (k === "scheme") out.scheme = v === "dark" ? "light" : "dark";
  }
  return out;
}

function scaleDelta(d: DirectionTuning, k: number): DirectionTuning {
  const out: DirectionTuning = { ...d };
  for (const [key, v] of Object.entries(d))
    if (typeof v === "number") (out as Record<string, number>)[key] = v * k;
  return out;
}

/** True when the words asked for something the lexicon turned into a change or a pick. */
export const understood = (p: ParsedRefinement): boolean => p.matched.length > 0 || p.pick !== null;
