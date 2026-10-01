// Pilot stand for Playwright (M2-15, deploy.yaml#pilot.env): the M2 rules (G1 + G2 at publish) with
// WIZARD_REGISTRATION=invite and WIZARD_PAYMENTS=off — no shop; pilot orgs publish to prod without a card.
// Run: `pnpm --filter @wizard/e2e exec tsx stand/pilot.ts`.
import { startStand } from "./stand.js";

await startStand("pilot");
