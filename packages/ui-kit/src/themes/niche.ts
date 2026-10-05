// themeForNiche (themes.yaml#selection): the agent picks one of the four presets from the niche of the brief.
// Keyword stems over the lower-cased Russian text; no match → strict (safe for any business).
import type { ThemePresetId } from "./presets.js";

const STEMS: Record<ThemePresetId, readonly string[]> = {
  warm: [
    "салон",
    "красот",
    "маникюр",
    "педикюр",
    "ногт",
    "парикмах",
    "барбер",
    "брови",
    "ресниц",
    "косметолог",
    "массаж",
    "кафе",
    "ресторан",
    "кофейн",
    "пекарн",
    "кондитер",
    "торт",
    "выпечк",
    "цвет",
    "флорист",
    "букет",
    "подар",
    "свадеб",
    "ателье",
    "швейн",
    "рукодел",
    "гостев",
    "гостиниц",
    "отель",
    "хостел",
    "груминг",
    "зоосалон",
  ],
  bright: [
    "фитнес",
    "спорт",
    "трениров",
    "танц",
    "хореограф",
    "курс",
    "онлайн-школ",
    "школ",
    "обучени",
    "репетитор",
    "детск",
    "кружок",
    "кружк",
    "лагер",
    "мероприят",
    "событи",
    "фестивал",
    "концерт",
    "форум",
    "конференц",
    "квест",
    "развлеч",
    "игр",
    "клуб",
    "молодеж",
    "молодёж",
    "ивент",
  ],
  calm: [
    "психолог",
    "психотерап",
    "коуч",
    "йог",
    "медитац",
    "клиник",
    "стоматолог",
    "врач",
    "медицин",
    "остеопат",
    "архитект",
    "интерьер",
    "фотограф",
    "галере",
    "музей",
    "библиотек",
    "нутрициолог",
    "ретрит",
  ],
  strict: [
    "юрист",
    "юридич",
    "адвокат",
    "нотари",
    "бухгалт",
    "финанс",
    "страхов",
    "консалт",
    "аудит",
    "b2b",
    "производств",
    "завод",
    "логист",
    "склад",
    "достав",
    "строит",
    "ремонт",
    "недвижим",
    "автосервис",
    "crm",
    "заявк",
    "учет",
    "учёт",
  ],
};

/** Preset id for a niche description («студия маникюра», «юридическая консультация»); strict when nothing matches. */
export function themeForNiche(niche: string): ThemePresetId {
  const text = niche.toLowerCase();
  let best: ThemePresetId = "strict";
  let score = 0;
  for (const id of ["warm", "bright", "calm", "strict"] as const) {
    const s = STEMS[id].filter((stem) => text.includes(stem)).length;
    if (s > score) {
      best = id;
      score = s;
    }
  }
  return best;
}
