// Shared part of end-user login (runtime.yaml#auth.login_page, #auth.role_assignment, #auth.consent_at_login;
// security/compliance.yaml#system_package.consent.login): methods by plan, the role of a new user, consent at the
// first login, the users row and the session.
import type { Role } from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { consentMatches } from "../compliance.js";
import { type DataTx, SYSTEM_SUBJECT } from "../data/access.js";
import type { LoadedSystem } from "../system.js";

export type LoginMethod = "email_otp" | "phone_otp" | "telegram";

export const PHONE_PLAN_MESSAGE = "Вход по телефону доступен на тарифах Старт и Бизнес";

/** phone_otp exists in prod only with registry.features.phoneOtp (F4); drafts show it with the plan note. */
export function planAllows(sys: LoadedSystem, method: LoginMethod): boolean {
  return method !== "phone_otp" || sys.entry.env === "draft" || sys.entry.features.phoneOtp;
}

const loginRoles = (sys: LoadedSystem) => sys.spec.roles.filter((r) => r.access === "login");

const roleHas = (r: Role, m: LoginMethod) => (r.loginMethods ?? []).includes(m);

/** 403 LOGIN_METHOD_UNAVAILABLE unless some login role has the method and the plan allows it. */
export function assertMethod(sys: LoadedSystem, method: LoginMethod): void {
  if (!loginRoles(sys).some((r) => roleHas(r, method)))
    throw new WizardError("LOGIN_METHOD_UNAVAILABLE", { message: "Этот способ входа недоступен" });
  if (!planAllows(sys, method))
    throw new WizardError("LOGIN_METHOD_UNAVAILABLE", { message: PHONE_PLAN_MESSAGE });
}

/** Role requested by /login?role=: must be a login role (the rest is decided at verify). */
export function requestedRole(sys: LoadedSystem, role: unknown): string | null {
  if (role === undefined || role === null || role === "") return null;
  if (typeof role !== "string" || !loginRoles(sys).some((r) => r.name === role))
    throw new WizardError("VALIDATION_FAILED", { fields: [{ field: "role", message: "Роль не найдена" }] });
  return role;
}

export type Identity =
  | { kind: "email"; email: string }
  | { kind: "phone"; phone: string }
  | { kind: "telegram"; telegramId: string; name: string | null; phone: string | null };

export interface LoginInput {
  identity: Identity;
  method: LoginMethod;
  role: string | null;
  consent: unknown;
  ipHmac: Buffer | null;
}

export interface LoginResult {
  user: Record<string, unknown>;
  created: boolean;
}

/** Role of a new user: the requested selfSignup role, or the only selfSignup role with this method (L1-31). */
function signupRole(sys: LoadedSystem, method: LoginMethod, wanted: string | null): Role {
  const open = loginRoles(sys).filter((r) => r.selfSignup === true && roleHas(r, method));
  const role = wanted ? open.find((r) => r.name === wanted) : open.length === 1 ? open[0] : undefined;
  if (role) return role;
  throw new WizardError("FORBIDDEN", {
    message:
      wanted || open.length === 0
        ? "Самостоятельная регистрация в эту роль закрыта. Попросите приглашение у администратора системы"
        : "Выберите роль для регистрации",
  });
}

async function findUser(
  sys: LoadedSystem,
  tx: DataTx,
  id: Identity,
): Promise<Record<string, unknown> | null> {
  const t = tx.sql`${tx.sql(sys.schema)}.${tx.sql("users")}`;
  let rows: readonly Record<string, unknown>[];
  if (id.kind === "email") rows = await tx.sql`select * from ${t} where email = ${id.email} for update`;
  else if (id.kind === "phone") rows = await tx.sql`select * from ${t} where phone = ${id.phone} for update`;
  else {
    rows = await tx.sql`select * from ${t} where telegram_id = ${id.telegramId} for update`;
    // An invited user (by phone) is recognised by the verified phone of the Telegram account (scope phone).
    if (!rows[0] && id.phone)
      rows = await tx.sql`select * from ${t} where phone = ${id.phone} and telegram_id is null for update`;
  }
  return rows[0] ? { ...rows[0] } : null;
}

/**
 * One SYSTEM transaction: find or create the user, enforce role rules, require `_consent` at the first login
 * (no row in _w_consents for this user) and record it. `extra` runs in the same transaction (consuming the OTP).
 * Throws WizardError: FORBIDDEN (blocked, closed signup), LOGIN_METHOD_UNAVAILABLE, CONSENT_REQUIRED.
 */
export async function resolveLogin(
  sys: LoadedSystem,
  i: LoginInput,
  extra?: (tx: DataTx) => Promise<void>,
): Promise<LoginResult> {
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const s = sys.schema;
    const users = tx.sql`${tx.sql(s)}.${tx.sql("users")}`;
    const consents = tx.sql`${tx.sql(s)}.${tx.sql("_w_consents")}`;
    let user = await findUser(sys, tx, i.identity);
    let role: Role | undefined;
    if (user) {
      if (user.blocked_at)
        throw new WizardError("FORBIDDEN", { message: "Вход для этого пользователя закрыт" });
      role = loginRoles(sys).find((r) => r.name === user?.role);
      if (!role) throw new WizardError("FORBIDDEN", { message: "Роль пользователя больше не существует" });
    } else {
      role = signupRole(sys, i.method, i.role);
    }
    if (!roleHas(role, i.method) || !planAllows(sys, i.method))
      throw new WizardError("LOGIN_METHOD_UNAVAILABLE", {
        message: planAllows(sys, i.method)
          ? "Этот способ входа недоступен для вашей роли"
          : PHONE_PLAN_MESSAGE,
      });
    const info = sys.compliance;
    let needConsent = info.consentTextHash !== "";
    if (needConsent && user) {
      const given = await tx.sql`
        select 1 from ${consents} where entity = 'users' and row_id = ${String(user.id)} limit 1`;
      needConsent = given.length === 0;
    }
    if (needConsent && !consentMatches(info, i.consent)) throw new WizardError("CONSENT_REQUIRED");
    await extra?.(tx);
    const id = i.identity;
    const created = !user;
    if (!user) {
      const rows = await tx.sql`
        insert into ${users} (role, display_name, email, phone, telegram_id, telegram_chat_id)
        values (
          ${role.name},
          ${id.kind === "telegram" ? id.name : null},
          ${id.kind === "email" ? id.email : null},
          ${id.kind === "phone" ? id.phone : id.kind === "telegram" ? id.phone : null},
          ${id.kind === "telegram" ? id.telegramId : null},
          ${id.kind === "telegram" ? id.telegramId : null})
        returning *`;
      user = { ...(rows[0] as Record<string, unknown>) };
    } else if (id.kind === "telegram") {
      // scope telegram:bot_access: the private chat id equals the user id (connectors/telegram.yaml#chat_linking).
      const rows = await tx.sql`
        update ${users} set telegram_id = ${id.telegramId},
          telegram_chat_id = coalesce(telegram_chat_id, ${id.telegramId}),
          display_name = coalesce(display_name, ${id.name})
        where id = ${String(user.id)} returning *`;
      user = { ...(rows[0] as Record<string, unknown>) };
    }
    // users.last_login_at drives the 3-year retention of login data (privacy/erasure.ts#retainUsers); schemas
    // created before the column existed skip it.
    await tx.sql
      .savepoint((sp) => sp`update ${users} set last_login_at = now() where id = ${String(user?.id)}`)
      .catch(() => {});
    if (needConsent)
      await tx.sql`
        insert into ${consents} (entity, row_id, policy_version, consent_text_hash, ip_hmac)
        values ('users', ${String(user.id)}, ${info.policyVersion},
          ${Buffer.from(info.consentTextHash, "hex")}, ${i.ipHmac})`;
    return { user, created };
  });
}

/** Body of {user} in /api/auth/verify and /me. */
export function userBody(sys: LoadedSystem, user: Record<string, unknown>) {
  const role = sys.spec.roles.find((r) => r.name === user.role);
  return {
    id: String(user.id),
    role: String(user.role),
    displayName: typeof user.display_name === "string" ? user.display_name : "",
    isAdmin: role?.isAdmin === true,
  };
}
