// Design system of the direction «Чистая медицина» (V5-09, grill-12 (2)): an explicit brand choice away from the
// palettes grill-11 (8) bans and from the pale-blue pastel of the niche.
import type { DesignSystemV3 } from "../../../v3/design/index.js";
import { designSystemV3, font } from "../../../v3/design/system.js";

/** «Чистая медицина»: scrub green on cool white, Wix Madefor Display headings and figures, IBM Plex Sans body. */
export const MEDICINE_DS: DesignSystemV3 = /* @__PURE__ */ (() => {
  const ds = designSystemV3({
    archetype: "calm_medical",
    brandColor: "#1D6B57",
    seed: "bar-clinic",
    niche: "стоматология",
    accentUse: "signal",
  });
  return {
    ...ds,
    name: "Чистая медицина",
    fonts: {
      display: font("Wix Madefor Display", 700),
      text: font("IBM Plex Sans", 400),
      why: "ровные цифры бланка и стерильной маркировки",
    },
    palette: {
      ...ds.palette,
      scheme: "light",
      light: { ...ds.palette.light, bg: "oklch(0.988 0.003 180)", surfaceAlt: "oklch(0.96 0.008 175)" },
    },
    // Form-like corners: controls and photos barely rounded.
    radius: { ...ds.radius, sm: 2, md: 4, lg: 6, control: 4 },
  };
})();

export const MEDICINE_BRAND =
  "Зелёный хирургического костюма #1D6B57 на холодном белом вместо голубой медицинской пастели; Wix Madefor Display даёт крупные ровные цифры цен и времени, IBM Plex Sans читается как бланк назначения.";
