// V3-12 (stretch): staff cabinets in the client's style — the --w-cab-* tokens of the cabinet look computed from the
// client's design system v3: the full token set of the look for every archetype and scheme, the site's surfaces,
// accent and card radius, the AA pairs of designLint kept.
import { CABINET_TOKENS, contrast } from "@wizard/ui-kit";
import { ARCHETYPE_IDS, cabinetTokensV3, cssHex, designSystemV3 } from "@wizard/ui-kit/v3/design";
import { describe, expect, test } from "vitest";

describe("cabinet tokens from the design system v3", () => {
  test.each(ARCHETYPE_IDS)(
    "%s: every token of the look, the site's colours, AA text and button label",
    (archetype) => {
      const ds = designSystemV3({ archetype, brandColor: "#2a7f9e", seed: 3, niche: "клиника" });
      for (const scheme of ["light", "dark"] as const) {
        const t = cabinetTokensV3(ds, scheme);
        expect(Object.keys(t).sort()).toEqual([...CABINET_TOKENS].sort());
        expect(t["--w-cab-bg"]).toBe(cssHex(ds.palette[scheme].bg));
        expect(t["--w-cab-accent"]).toBe(cssHex(ds.palette[scheme].accent));
        expect(t["--w-cab-radius-card"]).toBe(`${ds.radius.lg}px`);
        for (const fg of ["--w-cab-ink", "--w-cab-muted", "--w-cab-accent-text"] as const)
          expect(
            contrast(t[fg] as string, t["--w-cab-bg"] as string),
            `${scheme} ${fg}`,
          ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(t["--w-cab-accent-ink"] as string, t["--w-cab-accent"] as string),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
