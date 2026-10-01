// M2 stand for Playwright (M2-11): WIZARD_MILESTONE=M2 rules (card binding before prod, G2 at publish) and the
// platform's YooKassa shop on YookassaMock with a test checkout page (stand.ts, shop.ts).
// Run: `pnpm --filter @wizard/e2e exec tsx stand/m2.ts`.
import { startStand } from "./stand.js";

await startStand("m2");
