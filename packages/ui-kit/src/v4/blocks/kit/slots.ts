// Slot primitives of the blocks: the v3 pattern slots plus a Lucide icon name and the variant switch.
import { z } from "zod";
import { ICON_NAMES } from "./icons.js";

export { brandSlot, imageSlot, line, linkSlot, para } from "../../../v3/patterns/slots.js";

/** One icon of the Lucide family (D80 (3): one icon family per site). */
export const iconSlot = z.enum(ICON_NAMES);

/** The `variant` slot of a block: one of its variant ids. */
export const variantSlot = <const T extends readonly [string, ...string[]]>(ids: T) => z.enum(ids).optional();
