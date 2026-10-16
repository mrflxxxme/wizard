// CSS of the bar preview: the two design systems scoped by [data-site], one Tailwind theme for both (design/css.ts).
import { designSystemCss } from "../design/css.js";
import { BAKERY_DS, SERVICE_DS } from "./tokens.js";

/** Design CSS to compile with Tailwind: bakery under [data-site=bakery], car service under [data-site=service]. */
export function barDesignCss(): string {
  return [
    designSystemCss(BAKERY_DS, { scope: "[data-site=bakery]", autoScheme: false }),
    designSystemCss(SERVICE_DS, { scope: "[data-site=service]", autoScheme: false, theme: false }),
    "html{scroll-behavior:smooth}",
    "@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}}",
  ].join("\n");
}

/** Font families of both sites (their @font-face rules go before the design CSS). */
export const BAR_FONTS: readonly string[] = [BAKERY_DS, SERVICE_DS].flatMap((d) => [
  d.fonts.display.family,
  d.fonts.text.family,
]);
