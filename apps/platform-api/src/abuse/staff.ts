// Staff accounts (api.yaml#info.x-auth.M2, D21_beta_moderation, compliance.yaml#platform.security_org): users.is_staff
// with mandatory TOTP — enrolment (secret in the platform SecretStore, users.totp_secret_ref = secret://…), confirmation
// with hashed recovery codes, and a step-up of each session (sessions.mfa_verified_at, valid STAFF_MFA_TTL_MS).
// /admin/* without it → 403 MFA_REQUIRED; a non-staff user gets 404 (the console is not revealed).
import type { MiddlewareHandler } from "hono";
import { deriveKey } from "../auth/crypto.js";
import {
  matchRecovery,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryHash,
  verifyTotp,
} from "../auth/totp.js";
import type { Config } from "../config.js";
import { type Db, json } from "../db/index.js";
import { ApiError, invalid, notFound } from "../errors.js";
import type { AppEnv } from "../http/auth.js";
import type { SecretStore } from "../secrets/store.js";
import { staffAudit } from "./reports.js";

/** api.yaml#info.x-auth.M2: a TOTP confirmation is valid for 12 h within the session. */
export const STAFF_MFA_TTL_MS = 12 * 3600_000;
/** Wrong codes (TOTP or recovery) per staff account in 15 min before 429. */
export const MFA_FAILS_LIMIT = 5;
const MFA_FAILS_WINDOW_MS = 15 * 60_000;

export interface StaffDeps {
  db: Db;
  config: Pick<Config, "secretsKey">;
  secrets: SecretStore;
  mfaTtlMs?: number;
  now?: () => Date;
}

export interface StaffState {
  isStaff: boolean;
  mfaEnrolled: boolean;
  mfaVerifiedUntil: string | null;
}

const userTarget = (id: string) => `user:${id}`;

async function staffRow(db: Db, userId: string) {
  return db
    .selectFrom("platform.users")
    .select([
      "id",
      "email",
      "is_staff",
      "mfa_enrolled_at",
      "totp_secret_ref",
      "totp_last_step",
      "mfa_recovery_hashes",
    ])
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/** MFA state of the user in this session (sessionId undefined — dev header auth: never verified). */
export async function staffState(
  d: StaffDeps,
  userId: string,
  sessionId: string | undefined,
): Promise<StaffState> {
  const u = await staffRow(d.db, userId);
  if (!u?.is_staff) return { isStaff: false, mfaEnrolled: false, mfaVerifiedUntil: null };
  let until: Date | null = null;
  if (sessionId && u.mfa_enrolled_at) {
    const s = await d.db
      .selectFrom("platform.sessions")
      .select("mfa_verified_at")
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (s?.mfa_verified_at) {
      const t = new Date(new Date(s.mfa_verified_at).getTime() + (d.mfaTtlMs ?? STAFF_MFA_TTL_MS));
      if (t > (d.now?.() ?? new Date())) until = t;
    }
  }
  return {
    isStaff: true,
    mfaEnrolled: u.mfa_enrolled_at !== null,
    mfaVerifiedUntil: until?.toISOString() ?? null,
  };
}

/**
 * Guard of /admin/*: non-staff → 404 NOT_FOUND; staff without an enrolled and session-verified TOTP → 403
 * MFA_REQUIRED (`mfaSetup` routes — status, enrolment, verification — only need the staff flag).
 */
export function staffGuard(d: StaffDeps, o: { mfaSetup?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const st = await staffState(d, c.get("user").id, c.get("sessionId"));
    if (!st.isStaff) throw notFound("Страница");
    if (!o.mfaSetup && !st.mfaVerifiedUntil)
      throw new ApiError("MFA_REQUIRED", "Подтвердите вход кодом из приложения-аутентификатора", {
        mfaEnrolled: st.mfaEnrolled,
      });
    return next();
  };
}

const needSession = (sessionId: string | undefined): string => {
  if (!sessionId)
    throw new ApiError("MFA_REQUIRED", "Войдите в аккаунт по почте — подтверждение работает только в сессии");
  return sessionId;
};

async function failGuard(d: StaffDeps, userId: string): Promise<void> {
  const since = new Date((d.now?.() ?? new Date()).getTime() - MFA_FAILS_WINDOW_MS);
  const r = await d.db
    .selectFrom("platform.staff_audit_log")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("actor", "=", userId)
    .where("action", "=", "mfa_failed")
    .where("created_at", ">", since)
    .executeTakeFirstOrThrow();
  if (Number(r.n) >= MFA_FAILS_LIMIT)
    throw new ApiError("RATE_LIMITED", "Слишком много неверных кодов — попробуйте через 15 минут");
}

async function failed(d: StaffDeps, userId: string, what: string): Promise<never> {
  await staffAudit(d.db, userId, "mfa_failed", userTarget(userId), what);
  throw new ApiError("OTP_INVALID", "Неверный код");
}

/** Starts (or restarts, until confirmed) TOTP enrolment: a new secret and its otpauth:// URI, shown once. */
export async function enrollMfa(d: StaffDeps, userId: string, sessionId: string | undefined) {
  needSession(sessionId);
  const u = await staffRow(d.db, userId);
  if (!u?.is_staff) throw notFound("Страница");
  if (u.mfa_enrolled_at) throw invalid("Приложение-аутентификатор уже подключено");
  const secret = newTotpSecret();
  const ref = d.secrets.putPlatform(`staff/${userId}/totp`, secret);
  await d.db
    .updateTable("platform.users")
    .set({ totp_secret_ref: ref, totp_last_step: null, mfa_recovery_hashes: null })
    .where("id", "=", userId)
    .execute();
  await staffAudit(d.db, userId, "mfa_enroll_start", userTarget(userId));
  return { secret, otpauthUrl: otpauthUri(secret, u.email) };
}

const recoveryKey = (d: StaffDeps) => deriveKey(d.config.secretsKey, "staff-recovery");

/** Confirms enrolment with the first code: MFA enrolled, the session verified, recovery codes returned once. */
export async function confirmMfa(d: StaffDeps, userId: string, sessionId: string | undefined, code: string) {
  const sid = needSession(sessionId);
  await failGuard(d, userId);
  const now = d.now?.() ?? new Date();
  const out = await d.db.transaction().execute(async (trx) => {
    const u = await trx
      .selectFrom("platform.users")
      .select(["is_staff", "mfa_enrolled_at", "totp_secret_ref"])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!u.is_staff) throw notFound("Страница");
    if (u.mfa_enrolled_at) throw invalid("Приложение-аутентификатор уже подключено");
    const secret = u.totp_secret_ref ? d.secrets.getPlatform(u.totp_secret_ref) : null;
    if (!secret) throw invalid("Сначала начните подключение приложения-аутентификатора");
    const step = verifyTotp(secret, code, { at: now });
    if (step === null) return null;
    const codes = newRecoveryCodes();
    await trx
      .updateTable("platform.users")
      .set({
        mfa_enrolled_at: now,
        totp_last_step: step,
        mfa_recovery_hashes: json(codes.map((c) => recoveryHash(recoveryKey(d), userId, c))),
      })
      .where("id", "=", userId)
      .execute();
    await trx.updateTable("platform.sessions").set({ mfa_verified_at: now }).where("id", "=", sid).execute();
    await staffAudit(trx, userId, "mfa_enrolled", userTarget(userId));
    return codes;
  });
  if (!out) return failed(d, userId, "enroll");
  return { recoveryCodes: out, mfaVerifiedUntil: verifiedUntil(d, now) };
}

const verifiedUntil = (d: StaffDeps, at: Date) =>
  new Date(at.getTime() + (d.mfaTtlMs ?? STAFF_MFA_TTL_MS)).toISOString();

/** Step-up of the session by a TOTP code (each code once) or a one-time recovery code. */
export async function verifyMfa(
  d: StaffDeps,
  userId: string,
  sessionId: string | undefined,
  b: { code?: string | undefined; recoveryCode?: string | undefined },
) {
  const sid = needSession(sessionId);
  await failGuard(d, userId);
  const now = d.now?.() ?? new Date();
  const ok = await d.db.transaction().execute(async (trx) => {
    const u = await trx
      .selectFrom("platform.users")
      .select(["is_staff", "mfa_enrolled_at", "totp_secret_ref", "totp_last_step", "mfa_recovery_hashes"])
      .where("id", "=", userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!u.is_staff) throw notFound("Страница");
    if (!u.mfa_enrolled_at)
      throw new ApiError("MFA_REQUIRED", "Сначала подключите приложение-аутентификатор");
    if (b.recoveryCode) {
      const hashes = u.mfa_recovery_hashes ?? [];
      const i = matchRecovery(recoveryKey(d), userId, b.recoveryCode, hashes);
      if (i < 0) return false;
      await trx
        .updateTable("platform.users")
        .set({ mfa_recovery_hashes: json(hashes.filter((_, j) => j !== i)) })
        .where("id", "=", userId)
        .execute();
      await staffAudit(
        trx,
        userId,
        "mfa_recovery_used",
        userTarget(userId),
        `осталось кодов: ${hashes.length - 1}`,
      );
    } else {
      const secret = u.totp_secret_ref ? d.secrets.getPlatform(u.totp_secret_ref) : null;
      const last = u.totp_last_step === null ? null : Number(u.totp_last_step);
      const step = secret && b.code ? verifyTotp(secret, b.code, { at: now, lastStep: last }) : null;
      if (step === null) return false;
      await trx
        .updateTable("platform.users")
        .set({ totp_last_step: step })
        .where("id", "=", userId)
        .execute();
      await staffAudit(trx, userId, "mfa_verified", userTarget(userId));
    }
    await trx.updateTable("platform.sessions").set({ mfa_verified_at: now }).where("id", "=", sid).execute();
    return true;
  });
  if (!ok) return failed(d, userId, b.recoveryCode ? "recovery" : "totp");
  return { mfaVerifiedUntil: verifiedUntil(d, now) };
}

/** CLI: grant or revoke the staff flag (the founder in the beta, F7). The user must have signed in once. */
export async function setStaff(db: Db, email: string, on: boolean): Promise<string> {
  const r = await db
    .updateTable("platform.users")
    .set({ is_staff: on })
    .where("email", "=", email.trim().toLowerCase())
    .where("deleted_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!r) throw new Error("пользователь не найден — сначала войдите на платформу с этой почтой");
  // B2-01: the orgs a new staff user owns become staff orgs (revoking staff leaves them: PUT /admin/orgs/:id/flags).
  if (on)
    await db
      .updateTable("platform.orgs")
      .set({ kind: "staff" })
      .where("kind", "=", "client")
      .where("id", "in", (eb) =>
        eb
          .selectFrom("platform.memberships")
          .select("org_id")
          .where("user_id", "=", r.id)
          .where("role", "=", "owner"),
      )
      .execute();
  return r.id;
}

/** CLI: lost authenticator — forget the TOTP key and recovery codes; the next /admin visit enrols again. */
export async function resetStaffMfa(db: Db, secrets: SecretStore, email: string): Promise<void> {
  const u = await db
    .selectFrom("platform.users")
    .select(["id", "totp_secret_ref"])
    .where("email", "=", email.trim().toLowerCase())
    .executeTakeFirst();
  if (!u) throw new Error("пользователь не найден");
  if (u.totp_secret_ref) secrets.removePlatform(u.totp_secret_ref);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("platform.users")
      .set({ totp_secret_ref: null, mfa_enrolled_at: null, totp_last_step: null, mfa_recovery_hashes: null })
      .where("id", "=", u.id)
      .execute();
    await trx
      .updateTable("platform.sessions")
      .set({ mfa_verified_at: null })
      .where("user_id", "=", u.id)
      .execute();
  });
}
