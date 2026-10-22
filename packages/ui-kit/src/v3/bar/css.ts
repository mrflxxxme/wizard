// CSS of the bar preview: the two directions of the block library scoped by [data-site], one Tailwind theme for both.

import { BLOCKS_CSS, directionCss, directionFonts } from "../../v4/blocks/index.js";

/** Design CSS to compile with Tailwind: bakery under [data-site=bakery], car service under [data-site=service]. */
export function barDesignCss(): string {
  return [
    directionCss("masterskaya", "[data-site=bakery]"),
    directionCss("nochnoy-produkt", "[data-site=service]", false),
    directionCss("chistaya-medicina", "[data-site=clinic]", false),
    directionCss("redaktsiya", "[data-site=bureau]", false),
    "html{scroll-behavior:smooth}",
    "@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}",
    BLOCKS_CSS,
  ].join("\n");
}

/** Font families of both sites (their @font-face rules go before the design CSS). */
export const BAR_FONTS: readonly string[] = [
  ...directionFonts("masterskaya"),
  ...directionFonts("nochnoy-produkt"),
  ...directionFonts("chistaya-medicina"),
  ...directionFonts("redaktsiya"),
];
