// The two directions cut from the accepted bar sites (grill-11 (1), round 4; grill-12 (2)). Tokens come from the
// archetypes by code (designSystemV3); brand colour and font pair are an explicit brand choice, away from the
// palettes grill-11 (8) bans (cream + serif + terracotta, violet-blue gradient, black + acid accent).
import type { DesignSystemV3 } from "../../v3/design/index.js";
import { designSystemV3, font } from "../../v3/design/system.js";
import type { Direction, DirectionId } from "./types.js";

/** «Мастерская»: cobalt of enamel bread tins on a cool white, Alegreya headings, Golos Text body. */
export const MASTERSKAYA_DS: DesignSystemV3 = /* @__PURE__ */ (() => {
  const ds = designSystemV3({
    archetype: "warm_craft",
    brandColor: "#2443A6",
    seed: "bar-bakery",
    niche: "пекарня",
    accentUse: "signal",
  });
  return {
    ...ds,
    name: "Мастерская",
    fonts: {
      display: font("Alegreya", 700),
      text: font("Golos Text", 400),
      why: "рукописный ритм вывески хлебной",
    },
    palette: { ...ds.palette, scheme: "light" },
  };
})();

/** «Ночной продукт»: graphite night, sodium-lamp amber accent, Unbounded headings, Onest body. */
export const NOCHNOY_DS: DesignSystemV3 = /* @__PURE__ */ (() => {
  const ds = designSystemV3({
    archetype: "night_contrast",
    brandColor: "#E8A13A",
    seed: "bar-service",
    niche: "автосервис",
    accentUse: "signal",
  });
  return {
    ...ds,
    name: "Ночной продукт",
    fonts: {
      display: font("Unbounded", 700),
      text: font("Onest", 400),
      why: "широкие знаки как маркировка на щитке приборов",
    },
    palette: { ...ds.palette, scheme: "dark" },
  };
})();

export const DIRECTIONS: Record<DirectionId, Direction> = {
  masterskaya: {
    id: "masterskaya",
    title: "Мастерская",
    niches: ["пекарня", "кондитерская", "кофейня", "мастерская", "фермерская лавка"],
    grammar:
      "Продукт крупно на фото без скруглений, до края экрана. Заголовки Alegreya до 1,5 дисплейного кегля, плотный интерлиньяж. Прайс строками с весом и ценой, между строками линии в цвет текста. Половина экрана фото, половина текст; одно действие на экран.",
    design: MASTERSKAYA_DS,
    brandChoice:
      "Кобальт эмалированных хлебных форм #2443A6 на холодном белом вместо крема и терракоты; Alegreya держит ритм вывески, Golos Text делает прайс читаемым.",
    signature: {
      block: "masterskaya.moment",
      moment: "Время печи крупно на фото: цифры поднимаются из-под края, строка проявляется следом",
    },
  },
  "nochnoy-produkt": {
    id: "nochnoy-produkt",
    title: "Ночной продукт",
    niches: ["автосервис", "шиномонтаж", "ремонт техники", "сервис по записи", "мастерская на выезде"],
    grammar:
      "Сайт как приложение. Первый экран работает как инструмент: поле, выбор, расчёт; цифры доверия под ним. Графит и натриевый янтарь, широкий Unbounded для цифр и заголовков. Фото под тёмной вуалью, сетки 12 колонок, слоты времени и этапы крупными плитками.",
    design: NOCHNOY_DS,
    brandChoice:
      "Натриевый янтарь #E8A13A ночных фонарей на графите вместо чёрного с кислотным акцентом; Unbounded как маркировка щитка приборов, Onest для текста чата.",
    signature: {
      block: "nochnoy-produkt.status",
      moment: "Чат мастера: сообщения приходят по одному, этапы ремонта заполняются до текущего",
    },
  },
};
