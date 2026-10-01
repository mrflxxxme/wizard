// Staff founder-review CLI until the admin console with MFA (api.yaml#adminFounderReview; staff auth — M2-08/M2-09).
// Needs direct DB access (WIZARD_DB_URL / DATABASE_URL), like the credits CLI. Usage:
//   pnpm --filter @wizard/platform-api moderation reviews
//   pnpm --filter @wizard/platform-api moderation approve <systemId> <revision> [note…]
//   pnpm --filter @wizard/platform-api moderation reject <systemId> <revision> <note…>
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { decideFounderReview, pendingFounderReviews } from "./moderation.js";

async function main(argv: string[]): Promise<string> {
  const [cmd, systemId = "", rev = "", ...rest] = argv;
  const h = createDb(loadConfig().dbUrl, 2);
  try {
    if (cmd === "reviews") return JSON.stringify(await pendingFounderReviews(h.db), null, 2);
    if (cmd === "approve" || cmd === "reject") {
      const revision = Number(rev);
      const note = rest.join(" ").trim();
      if (!systemId || !Number.isInteger(revision) || (cmd === "reject" && note.length < 3))
        throw new Error(`${cmd} <systemId> <revision> ${cmd === "reject" ? "<note…>" : "[note…]"}`);
      const ok = await decideFounderReview(h.db, {
        systemId,
        revision,
        decision: cmd,
        ...(note ? { note } : {}),
      });
      if (!ok) throw new Error("ревизия не ждёт ревью");
      return cmd === "approve" ? "одобрено" : "отклонено";
    }
    throw new Error("команды: reviews | approve | reject");
  } finally {
    await h.close();
  }
}

main(process.argv.slice(2)).then(
  (out) => process.stdout.write(`${out}\n`),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
