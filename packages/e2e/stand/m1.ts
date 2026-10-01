// M1 stand for Playwright (M1-08, M1-11), see stand.ts. Run: `pnpm --filter @wizard/e2e exec tsx stand/m1.ts`.
import { startStand } from "./stand.js";

await startStand("m1");
