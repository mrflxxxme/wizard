import { readdirSync } from "node:fs";
import { join } from "node:path";
import { UI_KIT_ROOT } from "./demo.js";

/** Story names = file names of demo/stories/*.tsx (one per component). */
export const STORY_NAMES = readdirSync(join(UI_KIT_ROOT, "demo/stories"))
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => f.replace(/\.tsx$/, ""))
  .sort();
