// Design systems of the two bar sites (grill-11 (2)): «Мастерская» (sourdough bakery) and «Ночной продукт» (car
// service). Tokens come from the archetypes by code (designSystemV3); the brand colour and the font pair are an
// explicit brand choice, away from the palettes grill-11 (8) bans (cream + serif + terracotta, black + acid accent).
import type { DesignSystemV3 } from "../design/index.js";
import { designSystemV3, font } from "../design/system.js";

/** Bakery: cobalt of enamel bread tins on a cool white, Alegreya headings, Golos Text body. */
export const BAKERY_DS: DesignSystemV3 = (() => {
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

/** Car service: graphite night, sodium-lamp amber accent, Unbounded headings, Onest body. */
export const SERVICE_DS: DesignSystemV3 = (() => {
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
