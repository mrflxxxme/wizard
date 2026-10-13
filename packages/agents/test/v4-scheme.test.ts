// V4-01 (D79): ui/design.css of a public site has no prefers-color-scheme switch — the site stays in the scheme of
// its direction; :root carries that scheme's palette.
import { designSystemV3 } from "@wizard/ui-kit/v3/design";
import { describe, expect, test } from "vitest";
import { designCss } from "../src/builder/v3/compose/codegen.js";

describe("designCss keeps the direction's scheme", () => {
  for (const archetype of ["editorial", "night_contrast"] as const) {
    test(archetype, () => {
      const ds = designSystemV3({ archetype, brandColor: "#2F6B4F", seed: 3, niche: "Студия" });
      const css = designCss(ds);
      expect(css).not.toContain("prefers-color-scheme");
      expect(css).not.toContain("data-scheme=auto");
      const root = css.slice(css.indexOf(":root{"), css.indexOf("}", css.indexOf(":root{")));
      expect(root).toContain(`--ds-color-bg:${ds.palette[ds.palette.scheme].bg};`);
    });
  }
});
