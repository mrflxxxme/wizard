// V4-17: code mends a proposal before its check — what it can without changing the idea: a face outside the catalog →
// the nearest of the same kind, the scheme to the page, a cream page → a clean one of the same hue, AA of the text and
// the accent, «AI violet» turned away, the client's brand colour as the accent. A broken but mendable proposal then
// passes proposalIssues; a sound one is left as it is.
import { describe, expect, test } from "vitest";
import { contrast } from "../src/tokens/color.js";
import {
  autofixProposal,
  type DesignProposal,
  isCream,
  proposalFonts,
  proposalIssues,
} from "../src/v3/design/index.js";

const SOUND: DesignProposal = {
  name: "Чистая сетка",
  why: "Клиники выбирают по ясности: цены и запись на виду.",
  probability: 0.3,
  base: "swiss",
  scheme: "light",
  colors: { bg: "#FFFFFF", ink: "#111418", accent: "#C8102E" },
  fonts: { display: "Wix Madefor Display", text: "Wix Madefor Text" },
  type: { scale: "calm", upper: false },
  radius: "crisp",
  density: "airy",
  layout: "symmetric",
  motion: "still",
  imagery: { style: "предметная съёмка на белом фоне", treatment: "natural" },
};

describe("V4-17 autofixProposal", () => {
  test("a sound proposal is left as it is", () => {
    expect(proposalIssues(SOUND)).toEqual([]);
    expect(autofixProposal(SOUND)).toEqual({ proposal: SOUND, fixed: [] });
  });

  test("a broken but mendable one passes after the fixes", () => {
    const broken: DesignProposal = {
      ...SOUND,
      scheme: "dark",
      colors: { bg: "#F7F1E6", ink: "#9A9A9A", accent: "#8B5CF6" },
      fonts: { display: "Playfair Display", text: "Inter" },
    };
    expect(
      proposalIssues(broken)
        .map((i) => i.code)
        .sort(),
    ).toEqual(expect.arrayContaining(["SCHEME_MISMATCH", "TEXT_CONTRAST"]));
    const { proposal: p, fixed } = autofixProposal(broken);
    expect(fixed).toEqual(
      expect.arrayContaining([
        "fonts.display",
        "fonts.text",
        "scheme",
        "colors.bg",
        "colors.ink",
        "colors.accent",
      ]),
    );
    expect(proposalFonts().display).toContain(p.fonts.display);
    expect(proposalFonts().text).toContain(p.fonts.text);
    expect(p.scheme).toBe("light");
    expect(isCream(p.colors.bg)).toBe(false);
    expect(contrast(p.colors.ink, p.colors.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.colors.accent, p.colors.bg)).toBeGreaterThanOrEqual(3);
    expect(proposalIssues(p)).toEqual([]);
  });

  test("the client's brand colour becomes the accent", () => {
    const { proposal: p, fixed } = autofixProposal(SOUND, { brandColor: "#0e7490" });
    expect(p.colors.accent).toBe("#0E7490");
    expect(fixed).toContain("colors.accent");
    expect(proposalIssues(p, { brandColor: "#0E7490" })).toEqual([]);
  });
});
