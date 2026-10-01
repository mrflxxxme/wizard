// Founder pilot CLI (M2-15; product.yaml#decisions.D24_pilot_free, billing.yaml#plans.pilot). Direct DB access like
// the credits and moderation CLIs (WIZARD_DB_URL / DATABASE_URL); letters go through the platform mailer. Usage:
//   pnpm --filter @wizard/platform-api pilot invite <email> [--org-name <name>] [--credits <n>] [--review on|off]
//   pnpm --filter @wizard/platform-api pilot invites
//   pnpm --filter @wizard/platform-api pilot revoke <email>
//   pnpm --filter @wizard/platform-api pilot plan <orgId> pilot|free
//   pnpm --filter @wizard/platform-api pilot grant <orgId> <credits> [reference]
//   pnpm --filter @wizard/platform-api pilot orgs
//   pnpm --filter @wizard/platform-api pilot spend
//   pnpm --filter @wizard/platform-api pilot readiness [on|off] [--by <кто>] [--note <что сделано>]   (M2-09)
//   pnpm --filter @wizard/platform-api pilot review-required <orgId> on|off                          (M2-09)
// The same operations back the staff console «Пилот» (routes/admin-pilot.ts): the rules live in invites.ts, readiness.ts
// and service.ts; this file only parses arguments and formats text.
import type { Mailer } from "../auth/mailer.js";
import type { Billing } from "../billing/ledger.js";
import type { Db } from "../db/index.js";
import { createPilotInvite, PilotError } from "./invites.js";
import { getBetaReadiness, setBetaReadiness } from "./readiness.js";
import {
  grantPilotCredits,
  listPilotInvites,
  PILOT_GRANT_MAX,
  pilotOrgs,
  platformLlmSpend,
  revokePilotInvite,
  setFounderReviewRequired,
  setPilotPlan,
} from "./service.js";

export interface PilotCliDeps {
  db: Db;
  billing: Billing;
  mailer: Mailer;
  platformOrigin: string;
  llmMonthlyCapRub: number;
  now?: () => Date;
}

export const PILOT_CLI_USAGE = [
  "команды:",
  "  invite <email> [--org-name <название>] [--credits <N>] [--review on|off]   приглашение в пилот и письмо со ссылкой",
  "  invites                                                 приглашения (активные и принятые)",
  "  revoke <email>                                          отозвать активное приглашение",
  "  plan <orgId> pilot|free                                 назначить тариф",
  "  grant <orgId> <кредиты> [reference]                     начислить кредиты пилота (365 дней)",
  "  orgs                                                    организации: тариф, баланс, расход за месяц",
  "  spend                                                   расход платформы на модели за месяц и лимит",
  "  readiness [on|off] [--by <кто>] [--note <текст>]        готовность беты (M2-13): без неё приглашения не уходят",
  "  review-required <orgId> on|off                          ревью основателя перед первой публикацией в prod",
].join("\n");

/** Positional arguments and --flag value / --flag=value options. */
export function parseArgs(argv: string[]): { pos: string[]; opts: Record<string, string> } {
  const pos: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new PilotError(`${a}: нужно значение`);
      opts[a.slice(2)] = v;
      i++;
    }
  }
  return { pos, opts };
}

const fmt = (n: number, digits = 1) =>
  n.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** Runs one command; returns the text to print. Throws PilotError with a Russian message on bad input. */
export async function runPilotCli(argv: string[], d: PilotCliDeps): Promise<string> {
  const { pos, opts } = parseArgs(argv);
  const [cmd, a1 = "", a2 = "", a3] = pos;
  const now = d.now?.() ?? new Date();
  const day = (t: Date) => t.toISOString().slice(0, 10);
  switch (cmd) {
    case "invite": {
      if (!a1)
        throw new PilotError("invite <email> [--org-name <название>] [--credits <N>] [--review on|off]");
      const credits = opts.credits === undefined ? 0 : Number(opts.credits);
      if (opts.review !== undefined && opts.review !== "on" && opts.review !== "off")
        throw new PilotError("--review: on или off");
      const r = await createPilotInvite(
        d.db,
        d.mailer,
        { platformOrigin: d.platformOrigin, now },
        {
          email: a1,
          orgName: opts["org-name"] ?? null,
          credits,
          requireFounderReview: opts.review !== "off",
        },
      );
      return `приглашение отправлено: ${r.email} (до ${day(r.expiresAt)})\nссылка: ${r.link}`;
    }
    case "invites": {
      const rows = await listPilotInvites(d.db, now);
      if (rows.length === 0) return "приглашений нет";
      return rows
        .map((r) => {
          const st =
            r.status === "accepted" && r.acceptedAt
              ? `принято ${day(r.acceptedAt)}, org ${r.orgId}`
              : r.status === "expired"
                ? "истекло"
                : `ждёт входа до ${day(r.expiresAt)}`;
          return `${r.email}\t${r.orgName ?? "—"}\t${r.credits} кр.\t${st}`;
        })
        .join("\n");
    }
    case "revoke": {
      if (!a1) throw new PilotError("revoke <email>");
      return (await revokePilotInvite(d.db, { email: a1 }, now))
        ? "приглашение отозвано"
        : "активного приглашения нет";
    }
    case "plan": {
      if (a2 !== "pilot" && a2 !== "free") throw new PilotError("plan <orgId> pilot|free");
      const r = await setPilotPlan(d.db, a1, a2);
      return `«${r.org.name}»: тариф ${r.from} → ${a2}`;
    }
    case "grant": {
      const credits = Number(a2);
      if (!a1 || !Number.isFinite(credits) || credits <= 0 || credits > PILOT_GRANT_MAX)
        throw new PilotError("grant <orgId> <кредиты> [reference]: кредиты — число от 0 до 100 000");
      const r = await grantPilotCredits(d.db, d.billing, { orgId: a1, credits, reference: a3 ?? null });
      return `${r.granted ? `начислено ${fmt(credits)} кр.` : "уже начислено ранее (тот же reference)"} · «${r.org.name}»: доступно ${fmt(r.availableCredits)} кр.`;
    }
    case "orgs": {
      const { month, items } = await pilotOrgs(d.db, d.billing, { now });
      const lines = [
        `месяц ${month} (МСК)`,
        "orgId\tназвание\tтариф\tучастники\tдоступно кр.\tсписано кр.\tмодели ₽",
      ];
      for (const o of items)
        lines.push(
          [
            o.id,
            o.name,
            o.plan,
            String(o.members),
            fmt(o.creditsAvailable),
            fmt(o.creditsSpentMonth),
            fmt(o.modelSpendRub, 2),
          ].join("\t"),
        );
      return lines.join("\n");
    }
    case "spend": {
      const s = await platformLlmSpend(d.db, d.llmMonthlyCapRub, now);
      return `модели за ${s.month} (МСК): ${fmt(s.spentRub, 2)} ₽ из ${fmt(s.capRub, 0)} ₽ (${s.sharePercent} %)`;
    }
    case "readiness": {
      const show = (r: Awaited<ReturnType<typeof getBetaReadiness>>) =>
        r.at
          ? `beta_readiness: ${r.on ? "on" : "off"} (${r.by}, ${r.at.toISOString().slice(0, 16).replace("T", " ")} UTC)${r.note ? ` — ${r.note}` : ""}`
          : "beta_readiness: off (не отмечалась) — приглашения партнёрам не отправляются";
      if (!a1) return show(await getBetaReadiness(d.db));
      if (a1 !== "on" && a1 !== "off")
        throw new PilotError("readiness [on|off] [--by <кто>] [--note <текст>]");
      return show(
        await setBetaReadiness(d.db, { on: a1 === "on", by: opts.by ?? null, note: opts.note ?? null, now }),
      );
    }
    case "review-required": {
      if (a2 !== "on" && a2 !== "off") throw new PilotError("review-required <orgId> on|off");
      const { org } = await setFounderReviewRequired(d.db, a1, a2 === "on");
      return a2 === "on"
        ? `«${org.name}»: первая публикация каждой системы и новые формы сбора ПДн — после одобрения модератора`
        : `«${org.name}»: ревью перед prod только по сигналам антифрода G2`;
    }
    default:
      throw new PilotError(PILOT_CLI_USAGE);
  }
}
