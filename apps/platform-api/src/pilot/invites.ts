// Invite-only registration of the pilot (M2-15; product.yaml#decisions.D24_pilot_free, billing.yaml#plans.pilot,
// db.yaml#pilot_invites). WIZARD_REGISTRATION=invite: a NEW e-mail signs in only with an active founder invitation
// (created by the pilot CLI) or an active org invite; existing users sign in as before. The first sign-in with a
// founder invitation turns the personal org into a pilot org (name, plan pilot, credits as pilot_grant).
import type { Transaction } from "kysely";
import { z } from "zod";
import type { Mailer } from "../auth/mailer.js";
import type { Billing } from "../billing/ledger.js";
import type { DB, Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { BETA_READINESS_MISSING_RU, getBetaReadiness } from "./readiness.js";

type Trx = Transaction<DB>;

/** Lifetime of a founder invitation. */
export const PILOT_INVITE_DAYS = 30;

/** api.yaml#Error REGISTRATION_INVITE_ONLY */
export const REGISTRATION_INVITE_ONLY_RU =
  "Регистрация в Born to Build пока только по приглашению. Если вам прислали приглашение, войдите с адресом, на который оно пришло";

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .transform((s) => s.toLowerCase())
  .pipe(z.email());

/** Refusal of a pilot operation with a Russian message; `code` — the api.yaml#Error code the console answers with. */
export class PilotError extends Error {
  override name = "PilotError";
  constructor(
    message: string,
    readonly code: "VALIDATION_FAILED" | "FORBIDDEN" | "NOT_FOUND" = "VALIDATION_FAILED",
  ) {
    super(message);
  }
}

export interface PilotInviteInput {
  email: string;
  /** Name of the organization created at the first sign-in (default: the personal org name). */
  orgName?: string | null;
  /** Credits granted at the first sign-in (ledger pilot_grant). */
  credits?: number;
  /** orgs.require_founder_review of the pilot org (default true: the founder reviews before the first prod). */
  requireFounderReview?: boolean;
}

export interface PilotInviteResult {
  id: string;
  email: string;
  expiresAt: Date;
  link: string;
}

/** First screen after the first sign-in by the invitation: the pilot onboarding (platform-web /welcome, M2-09). */
export const PILOT_WELCOME_PATH = "/welcome";

/** Link of the invitation letter: the sign-in page with the address filled in, then the pilot onboarding. */
export const pilotInviteLink = (origin: string, email: string): string =>
  `${origin}/login?email=${encodeURIComponent(email)}&next=${encodeURIComponent(PILOT_WELCOME_PATH)}`;

/**
 * Founder invitation (pilot CLI): replaces an active one for the same address, then sends the letter through the
 * platform mailer. An already registered address needs no invitation (`pilot plan` assigns the plan instead).
 * M2-09: refused until the founder records beta_readiness (M2-13 done: lawyer, RKN notification).
 */
export async function createPilotInvite(
  db: Db,
  mailer: Mailer,
  o: { platformOrigin: string; now?: Date },
  input: PilotInviteInput,
): Promise<PilotInviteResult> {
  const parsed = emailSchema.safeParse(input.email);
  if (!parsed.success) throw new PilotError(`некорректный email: ${input.email}`);
  const email = parsed.data;
  const credits = input.credits ?? 0;
  if (!Number.isInteger(credits) || credits < 0) throw new PilotError("--credits: целое число ≥ 0");
  const orgName = input.orgName?.trim() || null;
  if (orgName && orgName.length > 120) throw new PilotError("--org-name: не длиннее 120 символов");
  if (!(await getBetaReadiness(db)).on) throw new PilotError(BETA_READINESS_MISSING_RU, "FORBIDDEN");
  const now = o.now ?? new Date();
  const expiresAt = new Date(now.getTime() + PILOT_INVITE_DAYS * 24 * 3600_000);
  const row = await db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom("platform.users")
      .select("id")
      .where("email", "=", email)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (user)
      throw new PilotError(
        `${email} уже зарегистрирован — приглашение не нужно; тариф назначает команда: pilot plan <orgId> pilot (список: pilot orgs)`,
      );
    await trx
      .updateTable("platform.pilot_invites")
      .set({ revoked_at: now })
      .where("email", "=", email)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();
    return trx
      .insertInto("platform.pilot_invites")
      .values({
        email,
        org_name: orgName,
        credits,
        expires_at: expiresAt,
        require_founder_review: input.requireFounderReview ?? true,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
  });
  const link = pilotInviteLink(o.platformOrigin, email);
  await mailer.send({
    kind: "invite",
    to: email,
    subject: "Приглашение в пилот Born to Build",
    text: [
      "Здравствуйте! Вас пригласили в пилот Born to Build. Здесь рабочие системы для бизнеса собираются в чате: вы описываете задачу своими словами, а мы собираем, проверяем и публикуем систему.",
      orgName ? `При первом входе мы создадим организацию «${orgName}».` : "",
      `Войти: ${link}`,
      "Укажите этот адрес почты — мы пришлём код входа. Приглашение действует 30 дней.",
      input.requireFounderReview === false
        ? "На пилоте всё бесплатно: 5 сборок и 20 правок за 30 дней. Если понадобится больше, напишите команде."
        : "На пилоте всё бесплатно: 5 сборок и 20 правок за 30 дней. Если понадобится больше, напишите команде. Перед первой публикацией системы её посмотрит команда.",
    ]
      .filter(Boolean)
      .join("\n"),
  });
  return { id: row.id, email, expiresAt, link };
}

async function activePilotInvite(trx: Trx, email: string, now: Date) {
  return trx
    .selectFrom("platform.pilot_invites")
    .select(["id", "org_name", "credits"])
    .where("email", "=", email)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Sign-in of an e-mail without an account (verifyOtp, dev-login): the active founder invitation (any mode), or in
 * invite mode an active org invite; otherwise 403 REGISTRATION_INVITE_ONLY. Returns the founder invitation to apply.
 */
export async function admitNewUser(
  trx: Trx,
  email: string,
  mode: string,
  now: Date = new Date(),
  founderEmail: string | null = null,
): Promise<{ pilotInviteId: string | null }> {
  const pilot = await activePilotInvite(trx, email, now);
  if (pilot) return { pilotInviteId: pilot.id };
  if (mode !== "invite") return { pilotInviteId: null };
  // The founder (WIZARD_FOUNDER_EMAIL) opens the invite-only pilot: nobody can invite the first account.
  if (founderEmail && email.toLowerCase() === founderEmail) return { pilotInviteId: null };
  const orgInvite = await trx
    .selectFrom("platform.invites")
    .select("id")
    .where("email", "=", email)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  if (orgInvite) return { pilotInviteId: null };
  throw new ApiError("REGISTRATION_INVITE_ONLY", REGISTRATION_INVITE_ONLY_RU);
}

/**
 * First sign-in with a founder invitation: the personal org becomes the pilot org (name, plan pilot, founder review
 * before prod as the invitation says, on by default — abuse.yaml#identification.founder_review, M2-09), the invited credits are granted
 * (pilot_grant:invite:<id>) and the invitation is accepted. Same transaction as the user.
 */
export async function acceptPilotInvite(
  trx: Trx,
  billing: Billing,
  inviteId: string,
  user: { id: string; orgId: string },
  now: Date = new Date(),
): Promise<void> {
  const inv = await trx
    .selectFrom("platform.pilot_invites")
    .select(["id", "org_name", "credits", "require_founder_review", "accepted_at", "revoked_at"])
    .where("id", "=", inviteId)
    .forUpdate()
    .executeTakeFirst();
  if (!inv || inv.accepted_at || inv.revoked_at) return;
  await trx
    .updateTable("platform.orgs")
    .set({
      plan: "pilot",
      require_founder_review: inv.require_founder_review,
      ...(inv.org_name ? { name: inv.org_name } : {}),
    })
    .where("id", "=", user.orgId)
    .execute();
  await trx
    .updateTable("platform.pilot_invites")
    .set({ accepted_at: now, accepted_user_id: user.id, org_id: user.orgId })
    .where("id", "=", inv.id)
    .execute();
  if (inv.credits > 0)
    await billing.grantPilot(trx, user.orgId, {
      credits: inv.credits,
      reference: `invite:${inv.id}`,
      createdBy: user.id,
    });
}
