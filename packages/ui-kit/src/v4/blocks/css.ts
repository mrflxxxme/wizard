// CSS of a direction: its design system scoped to a selector plus the keyframes the blocks use.
import { designSystemCss } from "../../v3/design/css.js";
import { DIRECTIONS } from "./directions.js";
import type { DirectionId } from "./types.js";

/** Keyframes of the blocks: the hero photo of «Мастерская» settles in on a wide screen with motion allowed. */
export const BLOCKS_CSS = [
  "@keyframes bar-drift{from{transform:scale(1.08)}to{transform:scale(1)}}",
  "@media (min-width:64rem) and (prefers-reduced-motion:no-preference){.bar-drift{animation:bar-drift 9s var(--ds-ease-out) both}}",
].join("\n");

/** Design CSS of a direction under `scope`; `theme: false` skips the shared Tailwind theme (one per page). */
export function directionCss(id: DirectionId, scope: string, theme = true): string {
  return designSystemCss(DIRECTIONS[id].design, { scope, autoScheme: false, theme });
}

/** Font families of a direction (their @font-face rules go before the design CSS). */
export const directionFonts = (id: DirectionId): string[] => {
  const f = DIRECTIONS[id].design.fonts;
  return [f.display.family, f.text.family];
};
