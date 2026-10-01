// Founder pilot CLI (M2-15; product.yaml#decisions.D24_pilot_free, billing.yaml#plans.pilot). Direct DB access like
// the credits and moderation CLIs (WIZARD_DB_URL / DATABASE_URL); letters go through the platform mailer. Usage:
//   pnpm --filter @wizard/platform-api pilot invite <email> [--org-name <name>] [--credits <n>]
//   pnpm --filter @wizard/platform-api pilot invites
//   pnpm --filter @wizard/platform-api pilot revoke <email>
//   pnpm --filter @wizard/platform-api pilot plan <orgId> pilot|free
//   pnpm --filter @wizard/platform-api pilot grant <orgId> <credits> [reference]
//   pnpm --filter @wizard/platform-api pilot orgs
//   pnpm --filter @wizard/platform-api pilot spend
//   pnpm --filter @wizard/platform-api pilot readiness [on|off] [--by <кто>] [--note <что сделано>]   (M2-09)
//   pnpm --filter @wizard/platform-api pilot review-required <orgId> on|off                          (M2-09)
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Mailer } from "../auth/mailer.js";
import type { Billing } from "../billing/ledger.js";
import { llmSpentRub, moscowMonth } from "../billing/llm-cap.js";
import type { Db } from "../db/index.js";
import { createPilotInvite, PilotError } from "./invites.js";
import { getBetaReadiness, setBetaReadiness } from "./readiness.js";

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
  "  invite <email> [--org-name <название>] [--credits <N>]   приглашение в пилот и письмо со ссылкой",
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function orgExists(db: Db, orgId: string): Promise<{ id: string; name: string; plan: string }> {
  if (!UUID.test(orgId)) throw new PilotError(`некорректный orgId: ${orgId}`);
  const o = await db
    .selectFrom("platform.orgs")
    .select(["id", "name", "plan"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!o) throw new PilotError(`организация ${orgId} не найдена`);
  return o;
}

const fmt = (n: number, digits = 1) =>
  n.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** Runs one command; returns the text to print. Throws PilotError with a Russian message on bad input. */
export async function runPilotCli(argv: string[], d: PilotCliDeps): Promise<string> {
  const { pos, opts } = parseArgs(argv);
  const [cmd, a1 = "", a2 = "", a3] = pos;
  const now = d.now?.() ?? new Date();
  switch (cmd) {
    case "invite": {
      if (!a1) throw new PilotError("invite <email> [--org-name <название>] [--credits <N>]");
      const credits = opts.credits === undefined ? 0 : Number(opts.credits);
      const r = await createPilotInvite(
        d.db,
        d.mailer,
        { platformOrigin: d.platformOrigin, now },
        { email: a1, orgName: opts["org-name"] ?? null, credits },
      );
      return `приглашение отправлено: ${r.email} (до ${r.expiresAt.toISOString().slice(0, 10)})\nссылка: ${r.link}`;
    }
    case "invites": {
      const rows = await d.db
        .selectFrom("platform.pilot_invites")
        .select(["email", "org_name", "credits", "expires_at", "accepted_at", "org_id", "revoked_at"])
        .where("revoked_at", "is", null)
        .orderBy("created_at", "desc")
        .execute();
      if (rows.length === 0) return "приглашений нет";
      return rows
        .map((r) => {
          const st = r.accepted_at
            ? `принято ${new Date(r.accepted_at).toISOString().slice(0, 10)}, org ${r.org_id}`
            : new Date(r.expires_at) <= now
              ? "истекло"
              : `ждёт входа до ${new Date(r.expires_at).toISOString().slice(0, 10)}`;
          return `${r.email}\t${r.org_name ?? "—"}\t${r.credits} кр.\t${st}`;
        })
        .join("\n");
    }
    case "revoke": {
      if (!a1) throw new PilotError("revoke <email>");
      const res = await d.db
        .updateTable("platform.pilot_invites")
        .set({ revoked_at: now })
        .where("email", "=", a1.trim().toLowerCase())
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(res.numUpdatedRows) > 0 ? "приглашение отозвано" : "активного приглашения нет";
    }
    case "plan": {
      if (a2 !== "pilot" && a2 !== "free") throw new PilotError("plan <orgId> pilot|free");
      const org = await orgExists(d.db, a1);
      const sub = await d.db
        .selectFrom("platform.subscriptions")
        .select("status")
        .where("org_id", "=", org.id)
        .executeTakeFirst();
      if (sub && (sub.status === "active" || sub.status === "past_due"))
        throw new PilotError(
          "у организации есть подписка — сначала отмените её (тариф оплачен через магазин)",
        );
      await d.db.updateTable("platform.orgs").set({ plan: a2 }).where("id", "=", org.id).execute();
      return `«${org.name}»: тариф ${org.plan} → ${a2}`;
    }
    case "grant": {
      const credits = Number(a2);
      if (!a1 || !Number.isFinite(credits) || credits <= 0 || credits > 100_000)
        throw new PilotError("grant <orgId> <кредиты> [reference]: кредиты — число от 0 до 100 000");
      const org = await orgExists(d.db, a1);
      const reference = a3 ?? randomUUID();
      const done = await d.db
        .transaction()
        .execute((trx) => d.billing.grantPilot(trx, org.id, { credits, reference }));
      const bal = await d.billing.readBalance(d.db, org.id);
      return `${done ? `начислено ${fmt(credits)} кр.` : "уже начислено ранее (тот же reference)"} · «${org.name}»: доступно ${fmt(bal.available / 1000)} кр.`;
    }
    case "orgs": {
      const m = moscowMonth(now);
      const orgs = await d.db
        .selectFrom("platform.orgs as o")
        .select([
          "o.id",
          "o.name",
          "o.plan",
          (eb) =>
            eb
              .selectFrom("platform.memberships as m")
              .select((x) => x.fn.countAll<string>().as("n"))
              .whereRef("m.org_id", "=", "o.id")
              .as("members"),
        ])
        .orderBy("o.created_at")
        .execute();
      const lines = [
        `месяц ${m.key} (МСК)`,
        "orgId\tназвание\tтариф\tучастники\tдоступно кр.\tсписано кр.\tмодели ₽",
      ];
      for (const o of orgs) {
        const bal = await d.billing.readBalance(d.db, o.id);
        const charged = await d.db
          .selectFrom("platform.credit_ledger")
          .select(sql<string>`coalesce(-sum(amount_milli), 0)`.as("milli"))
          .where("org_id", "=", o.id)
          .where("kind", "in", ["charge", "refund"])
          .where("created_at", ">=", m.start)
          .where("created_at", "<", m.end)
          .executeTakeFirstOrThrow();
        const rub = await llmSpentRub(d.db, m.start, m.end, o.id);
        lines.push(
          [
            o.id,
            o.name,
            o.plan,
            String(o.members ?? 0),
            fmt(bal.available / 1000),
            fmt(Number(charged.milli) / 1000),
            fmt(rub, 2),
          ].join("\t"),
        );
      }
      return lines.join("\n");
    }
    case "spend": {
      const m = moscowMonth(now);
      const rub = await llmSpentRub(d.db, m.start, m.end);
      const share = Math.floor((100 * rub) / d.llmMonthlyCapRub);
      return `модели за ${m.key} (МСК): ${fmt(rub, 2)} ₽ из ${fmt(d.llmMonthlyCapRub, 0)} ₽ (${share} %)`;
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
      const org = await orgExists(d.db, a1);
      await d.db
        .updateTable("platform.orgs")
        .set({ require_founder_review: a2 === "on" })
        .where("id", "=", org.id)
        .execute();
      return a2 === "on"
        ? `«${org.name}»: первая публикация каждой системы и новые формы сбора ПДн — после одобрения модератора`
        : `«${org.name}»: ревью перед prod только по сигналам антифрода G2`;
    }
    default:
      throw new PilotError(PILOT_CLI_USAGE);
  }
}
