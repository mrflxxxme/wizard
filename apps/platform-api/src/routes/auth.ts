// /auth/*, /me of specs/platform/api.yaml (x-milestone M1): email OTP, sessions, dev-login (local only).

import { type Context, Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import { ensureUser, memberships, OFFER_VERSION } from "../auth/accounts.js";
import { deriveKey, hmacHex, otpCode, safeEqualHex } from "../auth/crypto.js";
import type { Mailer } from "../auth/mailer.js";
import { applyRegion, type GeoRegion, isRestrictedRegion } from "../auth/region.js";
import { clearCookies, issueSession, revokeSession, sessionCookies } from "../auth/sessions.js";
import { ApiError, notFound } from "../errors.js";
import { type AppEnv, clientIp } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import { acceptPilotInvite, admitNewUser } from "../pilot/invites.js";

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_PER_EMAIL_HOUR = 5;
export const OTP_PER_IP_HOUR = 20;

export interface AccountDeps {
  mailer: Mailer;
  geoRegion?: GeoRegion | undefined;
}

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .transform((s) => s.toLowerCase())
  .pipe(z.email());

type Db = Deps["db"];
type UserRow = { id: string; email: string; name: string | null; is_staff: boolean };
const toUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  isStaff: u.is_staff,
  mfaEnrolled: false,
});

/** data-boundary.yaml#region_restriction: a login geolocated to a restricted region restricts all orgs of the user. */
async function recheckRegion(db: Db, geo: GeoRegion | undefined, userId: string, ip: string): Promise<void> {
  if (!geo) return;
  const region = await geo(ip);
  if (!isRestrictedRegion(region)) return;
  await db.transaction().execute(async (trx) => {
    const orgs = await trx
      .selectFrom("platform.orgs")
      .select(["id", "region_code", "t1_restricted"])
      .where(
        "id",
        "in",
        trx.selectFrom("platform.memberships").select("org_id").where("user_id", "=", userId),
      )
      .forUpdate()
      .execute();
    for (const o of orgs) {
      const next = applyRegion(o, { loginRegion: region });
      if (next.t1_restricted !== o.t1_restricted)
        await trx.updateTable("platform.orgs").set({ t1_restricted: true }).where("id", "=", o.id).execute();
    }
  });
}

export function authRoutes(d: Deps, a: AccountDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const otpKey = deriveKey(d.config.secretsKey, "otp-pepper");
  const ipKey = deriveKey(d.config.secretsKey, "ip-hash");
  const codeHash = (email: string, code: string) => hmacHex(otpKey, `${email}\u0000${code}`);

  async function login(c: Context<AppEnv>, user: UserRow) {
    const s = await issueSession(d.db, user.id);
    for (const v of sessionCookies(d.config, s.token, s.csrf, s.expiresAt))
      c.header("set-cookie", v, { append: true });
    c.header("cache-control", "no-store");
    await recheckRegion(d.db, a.geoRegion, user.id, clientIp(c, d.config.trustedProxies)).catch(() => {});
    return c.json({ user: toUser(user) }, 200);
  }

  // requestOtp: always 204; limits per e-mail and per IP.
  r.post("/auth/otp/request", async (c) => {
    const b = await jsonBody(c, z.object({ email: emailSchema }));
    const ipHash = hmacHex(ipKey, clientIp(c, d.config.trustedProxies));
    const code = otpCode();
    await d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`otp:${b.email}`}))`.execute(trx);
      const since = new Date(Date.now() - 3600_000);
      const [byEmail, byIp] = await Promise.all([
        trx
          .selectFrom("platform.auth_otps")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("email", "=", b.email)
          .where("created_at", ">", since)
          .executeTakeFirstOrThrow(),
        trx
          .selectFrom("platform.auth_otps")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("ip_hash", "=", ipHash)
          .where("created_at", ">", since)
          .executeTakeFirstOrThrow(),
      ]);
      if (Number(byEmail.n) >= OTP_PER_EMAIL_HOUR || Number(byIp.n) >= OTP_PER_IP_HOUR)
        throw new ApiError("RATE_LIMITED", "Слишком много попыток — попробуйте через час");
      await trx
        .insertInto("platform.auth_otps")
        .values({
          email: b.email,
          code_hash: codeHash(b.email, code),
          expires_at: new Date(Date.now() + OTP_TTL_MS),
          ip_hash: ipHash,
        })
        .execute();
    });
    await a.mailer.send({
      kind: "otp",
      to: b.email,
      subject: `Код входа в Wizard: ${code}`,
      text: `Ваш код входа: ${code}\nОн действует 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.`,
    });
    return c.body(null, 204);
  });

  // verifyOtp: a new user (or a new offer version) must pass both consents separately (compliance.yaml#platform).
  r.post("/auth/otp/verify", async (c) => {
    const b = await jsonBody(
      c,
      z.object({
        email: emailSchema,
        code: z.string().regex(/^[0-9]{6}$/),
        acceptOffer: z.boolean().optional(),
        pdConsent: z.boolean().optional(),
      }),
    );
    const out = await d.db.transaction().execute(async (trx) => {
      const otp = await trx
        .selectFrom("platform.auth_otps")
        .select(["id", "code_hash", "attempts"])
        .where("email", "=", b.email)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", new Date())
        .orderBy("created_at", "desc")
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) return { kind: "invalid" as const };
      if (!safeEqualHex(codeHash(b.email, b.code), otp.code_hash)) {
        await trx
          .updateTable("platform.auth_otps")
          .set({ attempts: otp.attempts + 1 })
          .where("id", "=", otp.id)
          .execute();
        return { kind: "invalid" as const };
      }
      const existing = await trx
        .selectFrom("platform.users")
        .select(["offer_version", "pd_consent_at"])
        .where("email", "=", b.email)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      // M2-15 (WIZARD_REGISTRATION=invite): a new address needs an invitation; checked after the code proved the
      // mailbox, before the consents — the refusal reaches only the mailbox owner (requestOtp stays 204).
      const admission = existing
        ? { pilotInviteId: null }
        : await admitNewUser(trx, b.email, d.config.registration);
      const needOffer = existing?.offer_version !== OFFER_VERSION;
      const needPd = !existing?.pd_consent_at;
      const missing = [
        ...(needOffer && b.acceptOffer !== true ? ["acceptOffer"] : []),
        ...(needPd && b.pdConsent !== true ? ["pdConsent"] : []),
      ];
      // The code stays valid: the user ticks the boxes and sends it again.
      if (missing.length > 0) return { kind: "consent" as const, missing };
      await trx
        .updateTable("platform.auth_otps")
        .set({ consumed_at: new Date() })
        .where("id", "=", otp.id)
        .execute();
      const user = await ensureUser(trx, b.email, { offer: needOffer, pd: needPd });
      if (admission.pilotInviteId && user.createdOrgId)
        await acceptPilotInvite(trx, d.billing, admission.pilotInviteId, {
          id: user.id,
          orgId: user.createdOrgId,
        });
      return { kind: "ok" as const, user };
    });
    if (out.kind === "invalid") throw new ApiError("OTP_INVALID", "Неверный или устаревший код");
    if (out.kind === "consent")
      throw new ApiError(
        "CONSENT_REQUIRED",
        out.missing.length === 2
          ? "Примите оферту и дайте согласие на обработку персональных данных"
          : out.missing[0] === "acceptOffer"
            ? "Примите оферту"
            : "Дайте согласие на обработку персональных данных",
        { missing: out.missing },
      );
    return login(c, out.user);
  });

  // Local only (WIZARD_AUTH_MODE=dev or WIZARD_DEV_LOGIN=1; startup refuses both in production / non-loopback).
  r.post("/auth/dev-login", async (c) => {
    if (d.config.authMode !== "dev" && !d.config.devLogin) throw notFound("Страница");
    const b = await jsonBody(c, z.object({ email: emailSchema }));
    const user = await d.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom("platform.users")
        .select("id")
        .where("email", "=", b.email)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      // Dev-login skips the code, not the invite-only registration (M2-15).
      const admission = existing
        ? { pilotInviteId: null }
        : await admitNewUser(trx, b.email, d.config.registration);
      const u = await ensureUser(trx, b.email, { offer: false, pd: false });
      if (admission.pilotInviteId && u.createdOrgId)
        await acceptPilotInvite(trx, d.billing, admission.pilotInviteId, { id: u.id, orgId: u.createdOrgId });
      return u;
    });
    return login(c, user);
  });

  // logout
  r.post("/auth/logout", async (c) => {
    const sid = c.get("sessionId");
    if (sid) await revokeSession(d.db, sid);
    for (const v of clearCookies(d.config)) c.header("set-cookie", v, { append: true });
    return c.body(null, 204);
  });

  // getMe
  r.get("/me", async (c) => {
    const me = c.get("user");
    const u = await d.db
      .selectFrom("platform.users")
      .select(["id", "email", "name", "is_staff"])
      .where("id", "=", me.id)
      .executeTakeFirstOrThrow();
    return c.json({ user: toUser(u), memberships: await memberships(d.db, me.id) });
  });

  return r;
}
