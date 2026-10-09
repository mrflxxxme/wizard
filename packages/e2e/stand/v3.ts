// v3 stand for Playwright (D78): WIZARD_BUILD_PIPELINE=v3 on recorded model answers (stand.ts, v3-models.ts).
// Run: `pnpm --filter @wizard/e2e exec tsx stand/v3.ts`.
import { startStand } from "./stand.js";

await startStand("v3");
