// CSS of the bar preview: the two directions of the block library scoped by [data-site], one Tailwind theme for both.

import { EDITORIAL_DS } from "../../v4/blocks/editorial/design.js";
import { BLOCKS_CSS, directionCss, directionFonts } from "../../v4/blocks/index.js";
import { MEDICINE_DS } from "../../v4/blocks/medicine/design.js";
import { designSystemCss } from "../design/css.js";

/** Design CSS to compile with Tailwind: bakery under [data-site=bakery], car service under [data-site=service]. */
export function barDesignCss(): string {
  return [
    directionCss("masterskaya", "[data-site=bakery]"),
    directionCss("nochnoy-produkt", "[data-site=service]", false),
    designSystemCss(MEDICINE_DS, { scope: "[data-site=clinic]", autoScheme: false, theme: false }),
    designSystemCss(EDITORIAL_DS, { scope: "[data-site=bureau]", autoScheme: false, theme: false }),
    "html{scroll-behavior:smooth}",
    "@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}",
    BLOCKS_CSS,
  ].join("\n");
}

/** Font families of both sites (their @font-face rules go before the design CSS). */
export const BAR_FONTS: readonly string[] = [
  ...directionFonts("masterskaya"),
  ...directionFonts("nochnoy-produkt"),
  ...[MEDICINE_DS, EDITORIAL_DS].flatMap((d) => [d.fonts.display.family, d.fonts.text.family]),
];
