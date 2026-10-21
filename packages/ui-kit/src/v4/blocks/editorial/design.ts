// Design system of the direction «Редакция» (V5-09, grill-12 (2)): serif on cool paper with the editor's red pencil;
// not cream + serif + terracotta (grill-11 (8)): the ground is cool white and the accent is a cold crimson.
import type { DesignSystemV3 } from "../../../v3/design/index.js";
import { designSystemV3, font } from "../../../v3/design/system.js";

/** «Редакция»: newsprint white, ink black, red pencil crimson, Cormorant Garamond headings, Commissioner body. */
export const EDITORIAL_DS: DesignSystemV3 = /* @__PURE__ */ (() => {
  const ds = designSystemV3({
    archetype: "editorial",
    brandColor: "#B0123A",
    seed: "bar-bureau",
    niche: "бюро переводов",
    accentUse: "signal",
  });
  return {
    ...ds,
    name: "Редакция",
    fonts: {
      display: font("Cormorant Garamond", 600),
      text: font("Commissioner", 400),
      why: "газетный заголовок и спокойный текст справки",
    },
    // Cool newsprint instead of the brand-tinted ground the archetype derives (no pink, no cream).
    palette: {
      ...ds.palette,
      scheme: "light",
      light: {
        ...ds.palette.light,
        bg: "oklch(0.975 0.003 250)",
        surfaceAlt: "oklch(0.94 0.004 250)",
        line: "oklch(0.86 0.004 250)",
      },
    },
  };
})();

export const EDITORIAL_BRAND =
  "Красный карандаш редактора #B0123A на холодной газетной бумаге и чёрная типографская краска вместо крема и терракоты; Cormorant Garamond для заголовков полосы, Commissioner для прайса и справок.";
