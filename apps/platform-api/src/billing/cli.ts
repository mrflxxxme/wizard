// Staff credits CLI until payments (M2): billing.yaml#ledger.kinds.adjustment — the only way in M1 to grant a paid
// plan or a topup. Needs direct DB access (WIZARD_DB_URL / DATABASE_URL). Usage:
//   pnpm --filter @wizard/platform-api credits balance <orgId>
//   pnpm --filter @wizard/platform-api credits topup <orgId> <packs> <reference>
//   pnpm --filter @wizard/platform-api credits plan <orgId> free|start|business [periodDays=30]
//   pnpm --filter @wizard/platform-api credits adjust <orgId> <±credits> <note…>
//   pnpm --filter @wizard/platform-api credits sweep
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { Billing } from "./ledger.js";
import { DAY_MS, type PlanId } from "./plans.js";

async function main(argv: string[]): Promise<string> {
  const [cmd, orgId = "", ...rest] = argv;
  const h = createDb(loadConfig().dbUrl, 2);
  const billing = new Billing();
  try {
    switch (cmd) {
      case "balance":
        return JSON.stringify(await billing.readBalance(h.db, orgId), null, 2);
      case "topup": {
        const packs = Number(rest[0]);
        if (!Number.isInteger(packs) || packs < 1 || !rest[1])
          throw new Error("topup <orgId> <packs> <reference>");
        const done = await h.db
          .transaction()
          .execute((trx) => billing.grantTopup(trx, orgId, { packs, key: `topup:staff:${rest[1]}` }));
        return done ? "начислено" : "уже начислено ранее (тот же reference)";
      }
      case "plan": {
        const plan = rest[0] as PlanId;
        if (!["free", "start", "business"].includes(plan))
          throw new Error("plan <orgId> free|start|business");
        const days = Number(rest[1] ?? 30);
        await h.db.transaction().execute(async (trx) => {
          await trx.updateTable("platform.orgs").set({ plan }).where("id", "=", orgId).execute();
          if (plan !== "free") {
            const start = billing.now();
            await billing.grantPlanPeriod(trx, orgId, {
              plan,
              start,
              end: new Date(start.getTime() + days * DAY_MS),
            });
          }
        });
        return `тариф ${plan}`;
      }
      case "adjust": {
        const credits = Number(rest[0]);
        const note = rest.slice(1).join(" ");
        if (!Number.isFinite(credits) || credits === 0 || !note)
          throw new Error("adjust <orgId> <±credits> <note>");
        await h.db.transaction().execute((trx) =>
          billing.adjust(trx, orgId, {
            amountMilli: Math.round(credits * 1000),
            key: `adjust:staff:${randomUUID()}`,
            note,
          }),
        );
        return "готово";
      }
      case "sweep":
        return `организаций: ${await billing.sweep(h.db)}`;
      default:
        throw new Error("команды: balance | topup | plan | adjust | sweep");
    }
  } finally {
    await h.close();
  }
}

main(process.argv.slice(2)).then(
  (out) => console.log(out),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
