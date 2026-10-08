// Sources of pattern compositions (research 2026-10-08 §4, D47, GZ-02): only MIT and Apache-2.0, each attributed in
// THIRD_PARTY_NOTICES.md; commercial and non-allowlisted libraries may not be used even as a model to rewrite.
import type { PatternLicense, PatternOrigin } from "./types.js";

export interface OriginInfo {
  name: string;
  url: string;
  license: Exclude<PatternLicense, "own">;
  /** Copyright line of the source's LICENSE (kept in THIRD_PARTY_NOTICES.md). */
  copyright: string;
}

/** Allowed sources (V3-08): shadcn/ui, Radix, Motion, HyperUI, Magic UI (free). */
export const PATTERN_ORIGINS: Readonly<Record<Exclude<PatternOrigin, "own">, OriginInfo>> = {
  hyperui: {
    name: "HyperUI",
    url: "https://github.com/markmead/hyperui",
    license: "MIT",
    copyright: "Copyright (c) Mark Mead",
  },
  "shadcn-ui": {
    name: "shadcn/ui",
    url: "https://github.com/shadcn-ui/ui",
    license: "MIT",
    copyright: "Copyright (c) 2023 shadcn",
  },
  radix: {
    name: "Radix Primitives",
    url: "https://github.com/radix-ui/primitives",
    license: "MIT",
    copyright: "Copyright (c) 2022 WorkOS",
  },
  motion: {
    name: "Motion",
    url: "https://github.com/motiondivision/motion",
    license: "MIT",
    copyright: "Copyright (c) 2024 Motion B.V.",
  },
  "magic-ui": {
    name: "Magic UI (бесплатная версия)",
    url: "https://github.com/magicuidesign/magicui",
    license: "MIT",
    copyright: "Copyright (c) Magic UI",
  },
};

/** Licenses a pattern may carry. */
export const ALLOWED_PATTERN_LICENSES: readonly PatternLicense[] = ["MIT", "Apache-2.0", "own"];

export interface ForbiddenSource {
  id: string;
  /** Names and markers (package names, hosts) that must not appear in patterns, their origins or dependencies. */
  markers: readonly string[];
  reason_ru: string;
}

/** Sources that never reach patterns, not even rewritten (research §4, builder-v3.md §1). */
export const FORBIDDEN_PATTERN_SOURCES: readonly ForbiddenSource[] = [
  {
    id: "tailwind-plus",
    markers: ["tailwind plus", "tailwindplus", "tailwind ui", "tailwindui"],
    reason_ru: "коммерческая лицензия прямо запрещает конструкторы сайтов",
  },
  { id: "aceternity", markers: ["aceternity"], reason_ru: "собственная коммерческая лицензия" },
  {
    id: "magic-ui-pro",
    markers: ["magic ui pro", "magicui pro", "magicui-pro", "pro.magicui"],
    reason_ru: "коммерческая лицензия",
  },
  {
    id: "react-bits-pro",
    markers: ["react bits pro", "reactbits pro", "pro.reactbits"],
    reason_ru: "коммерческая лицензия",
  },
  {
    id: "gsap",
    markers: ["gsap", "greensock"],
    reason_ru: "лицензия GSAP не входит в список AGENTS.md (не MIT, Apache-2.0, BSD или ISC)",
  },
];

/** The forbidden source a text mentions (case-insensitive), if any. */
export function forbiddenSourceIn(text: string): ForbiddenSource | undefined {
  const t = text.toLowerCase();
  return FORBIDDEN_PATTERN_SOURCES.find((s) => s.markers.some((m) => t.includes(m)));
}
