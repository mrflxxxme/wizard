// V4-07 test data: a submit_design_directions answer of five valid directions on different base archetypes (the brand
// colour, when given, is the accent of each), and its recorded fixture line for the fixture router.
import type { LlmMessage } from "@wizard/llm";
import type { DesignDirectionAnswer, DesignDirectionsAnswer } from "../src/builder/index.js";

const D = (
  o: Partial<DesignDirectionAnswer> & Pick<DesignDirectionAnswer, "name" | "base">,
): DesignDirectionAnswer => ({
  why: "Подходит бизнесу: клиенты выбирают по фото и честным ценам.",
  probability: 0.2,
  scheme: "light",
  colors: { bg: "#F7F5F2", ink: "#2A211B", accent: "#B5541B" },
  fonts: { display: "Alegreya", text: "Onest" },
  type: { scale: "classic", upper: false },
  radius: "soft",
  density: "regular",
  layout: "asymmetric",
  motion: "calm",
  imagery: { style: "крупные планы продукта, дневной свет", treatment: "warm-grade" },
  voice: "warm",
  ...o,
});

/** Five directions, likeliest first; `brand` replaces every accent (the client's colour stays the accent). */
export function fiveDirections(brand?: string): DesignDirectionsAnswer {
  const list: DesignDirectionAnswer[] = [
    D({ name: "Тёплая витрина", base: "warm_craft", probability: 0.4 }),
    D({
      name: "Почти витрина",
      base: "natural",
      probability: 0.25,
      radius: "round",
      colors: { bg: "#F4F6F1", ink: "#1F2A1C", accent: "#3F7D3A" },
    }),
    D({
      name: "Чистая сетка",
      base: "swiss",
      probability: 0.2,
      colors: { bg: "#FFFFFF", ink: "#111418", accent: "#C8102E" },
      fonts: { display: "Wix Madefor Display", text: "Wix Madefor Text" },
      type: { scale: "calm", upper: false },
      radius: "crisp",
      density: "airy",
      layout: "symmetric",
      motion: "still",
      imagery: { style: "предметная съёмка на белом фоне", treatment: "natural" },
      voice: "formal",
    }),
    D({
      name: "Ночная пекарня",
      base: "night_contrast",
      probability: 0.1,
      scheme: "dark",
      colors: { bg: "#14161A", ink: "#F2F0EB", accent: "#E0A030", accent2: "#3FA796" },
      fonts: { display: "Unbounded", text: "Source Sans 3", why: "Широкий гротеск держит короткие вывески." },
      type: { scale: "dramatic", upper: true },
      radius: "sharp",
      density: "compact",
      layout: "modular",
      motion: "lively",
      imagery: { style: "контрастные кадры печи ночью", treatment: "high-contrast" },
      voice: "bold",
    }),
    D({
      name: "Газетная колонка",
      base: "editorial",
      probability: 0.05,
      colors: { bg: "#FAFAF7", ink: "#1B1B1B", accent: "#1F5FA8" },
      fonts: { display: "Literata", text: "Commissioner" },
      type: { scale: "dramatic", upper: false },
      radius: "sharp",
      density: "airy",
      layout: "centered",
      imagery: { style: "документальные кадры без постановки", treatment: "natural" },
      voice: "calm",
    }),
  ];
  if (brand) for (const d of list) d.colors = { ...d.colors, accent: brand };
  return { directions: list };
}

/** The art director's prompt as the router sees it (re-exported for fixture lines). */
export type Messages = LlmMessage[];
