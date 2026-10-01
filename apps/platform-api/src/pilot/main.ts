// Entry of `pnpm --filter @wizard/platform-api pilot …` (commands: src/pilot/cli.ts). Letters go to the platform
// mailer (locally the outbox .data/outbox/platform, as the API's own letters).
import { OutboxMailer } from "../auth/mailer.js";
import { Billing } from "../billing/ledger.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { runPilotCli } from "./cli.js";
import { PilotError } from "./invites.js";

const config = loadConfig();
const h = createDb(config.dbUrl, 2);
try {
  const out = await runPilotCli(process.argv.slice(2), {
    db: h.db,
    billing: new Billing(),
    mailer: new OutboxMailer(config.outboxDir),
    platformOrigin: config.platformOrigin,
    llmMonthlyCapRub: config.llmMonthlyCapRub,
  });
  process.stdout.write(`${out}\n`);
} catch (e) {
  process.stderr.write(`${e instanceof PilotError || e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  await h.close();
}
