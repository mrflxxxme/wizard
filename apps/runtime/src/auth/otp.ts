// Email and phone OTP (runtime.yaml#auth.methods_M1.phone_otp, .email_otp, .verify; #auth.anti_abuse; L3-25):
// 6 digits, TTL 5 min, 5 attempts, resend after 60 s; _w_otp keeps only HMACs. The challenge id carries the
// destination and the requested role sealed (AES-GCM, bound to the system and the _w_otp row), so no contact is
// stored until the user exists.
import { randomInt, randomUUID } from "node:crypto";
import { isConnectorError, isPlainAddress, sendPlatformEmail } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { SYSTEM_SUBJECT } from "../data/access.js";
import { isLocalMode } from "../env.js";
import type { LoadedSystem } from "../system.js";
import { type AuthDeps, budgetOf, devSendSms, smsRoute } from "./deps.js";
import { sameBytes } from "./keys.js";
import { SMS_DAILY_BUDGET } from "./limits.js";
import { assertMethod, type Identity, type LoginResult, requestedRole, resolveLogin } from "./login.js";

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;

/** Error of the OTP flow with an explicit HTTP status (not in the shared SDK table). */
export class OtpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

const INVALID = "Неверный или устаревший код. Запросите новый";

/** Only Russian mobile numbers +7 9xx (runtime.yaml#auth.methods_M1.phone_otp); separators and 8… are accepted. */
export function normalizePhone(raw: string): string | null {
  let p = raw.replace(/[\s()\-‐–]/g, "");
  if (/^8\d{10}$/.test(p)) p = `+7${p.slice(1)}`;
  if (/^7\d{10}$/.test(p)) p = `+${p}`;
  return /^\+79\d{9}$/.test(p) ? p : null;
}

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && isPlainAddress(e) ? e : null;
}

type Sealed = { d: string; c: "email" | "phone"; r: string | null };

const aadOf = (sys: LoadedSystem, id: string) => `otp:${sys.entry.systemId}:${sys.entry.env}:${id}`;

export interface OtpStartInput {
  channel: unknown;
  destination: unknown;
  role: unknown;
  ip: string | null;
  /** Origin of the system host (links in the email). */
  origin: string;
  host: string;
}

export async function startOtp(
  deps: AuthDeps,
  sys: LoadedSystem,
  i: OtpStartInput,
): Promise<{ challengeId: string }> {
  if (i.channel !== "email" && i.channel !== "phone")
    throw new WizardError("VALIDATION_FAILED", {
      fields: [{ field: "channel", message: "Неизвестный канал" }],
    });
  const channel = i.channel;
  assertMethod(sys, channel === "email" ? "email_otp" : "phone_otp");
  const raw = typeof i.destination === "string" ? i.destination : "";
  const dest = channel === "email" ? normalizeEmail(raw) : normalizePhone(raw);
  if (!dest)
    throw new WizardError("VALIDATION_FAILED", {
      fields: [
        channel === "email"
          ? { field: "destination", message: "Некорректный адрес email" }
          : { field: "destination", message: "Нужен мобильный номер России в формате +7 9XX XXX-XX-XX" },
      ],
    });
  const role = requestedRole(sys, i.role);
  const route = channel === "phone" ? smsRoute(deps, sys) : null;
  if (channel === "phone" && route === null)
    throw new OtpError(503, "SMS_UNAVAILABLE", "Отправка SMS пока не настроена. Войдите другим способом");

  const now = deps.clock();
  const destinationHash = deps.keys.destination(`${channel}:${dest}`);
  const billable = channel === "phone" && sys.entry.env === "prod";
  const budget = billable ? await budgetOf(deps, sys) : null;
  const verdict = await deps.limiter.admit(
    {
      destination: destinationHash,
      systemId: sys.entry.systemId,
      env: sys.entry.env,
      channel,
      ip: deps.keys.ip(i.ip),
      orgKey: budget?.orgKey ?? null,
      billable,
      dailyBudget: budget ? (SMS_DAILY_BUDGET[budget.plan] ?? 0) : 0,
    },
    now,
  );
  if (!verdict.ok) {
    deps.log?.({
      ts: now.toISOString(),
      level: "warn",
      msg: verdict.code === "OTP_BUDGET_EXCEEDED" ? "sms_budget_exceeded" : "otp_rate_limited",
      system: sys.entry.slug,
      env: sys.entry.env,
      reason: verdict.reason,
    });
    throw verdict.code === "OTP_BUDGET_EXCEEDED"
      ? new OtpError(
          429,
          "OTP_BUDGET_EXCEEDED",
          "Лимит SMS на сегодня исчерпан. Войдите другим способом или попробуйте завтра",
          verdict.retryAfterSec,
        )
      : new OtpError(
          429,
          "RATE_LIMITED",
          "Слишком много запросов кода. Попробуйте позже",
          verdict.retryAfterSec,
        );
  }

  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const otp = sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const t = tx.sql`${tx.sql(sys.schema)}.${tx.sql("_w_otp")}`;
    // Expired codes go; a new code replaces older ones for the same destination.
    await tx.sql`delete from ${t} where expires_at < ${now} or destination_hash = ${destinationHash}`;
    await tx.sql`
      insert into ${t} (id, channel, destination_hash, code_hash, expires_at)
      values (${id}, ${channel}, ${destinationHash}, ${deps.keys.otp([id, dest, code])},
        ${new Date(now.getTime() + OTP_TTL_MS)})`;
  });
  await otp;
  try {
    if (channel === "email") await sendEmailCode(deps, sys, i, dest, code, id);
    else {
      const text = `${code} — код входа в «${sys.spec.app.name}». Никому его не сообщайте`;
      const m = { to: dest, text, systemId: sys.entry.systemId, env: sys.entry.env };
      if (route === "provider" && deps.smsSender) await deps.smsSender(m);
      else await devSendSms(deps, m);
    }
  } catch (e) {
    await sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
      await tx.sql`delete from ${tx.sql(sys.schema)}.${tx.sql("_w_otp")} where id = ${id}`;
    });
    if (e instanceof WizardError || e instanceof OtpError) throw e;
    deps.log?.({
      ts: new Date().toISOString(),
      level: "error",
      msg: "otp_delivery_failed",
      system: sys.entry.slug,
      env: sys.entry.env,
      channel,
      code: isConnectorError(e) ? e.code : "INTERNAL",
    });
    throw new OtpError(502, "OTP_DELIVERY_FAILED", "Не удалось отправить код. Попробуйте позже");
  }
  const sealed: Sealed = { d: dest, c: channel, r: role };
  return { challengeId: `${id}.${deps.keys.seal(sealed, aadOf(sys, id))}` };
}

async function sendEmailCode(
  deps: AuthDeps,
  sys: LoadedSystem,
  i: OtpStartInput,
  to: string,
  code: string,
  id: string,
): Promise<void> {
  const base = deps.connectors.platformMailCtx(sys, i.host);
  // Local runs without a platform mail account keep prod codes in the outbox too (dev/test only).
  const mode = isLocalMode(deps.env) && !deps.connectors.platform.smtp ? "test" : base.mode;
  await sendPlatformEmail(
    { ...base, mode, idempotencyKey: `otp:${id}` },
    {
      to,
      subject: `Код входа в «${sys.spec.app.name}»: ${code}`,
      text: `Ваш код входа в «${sys.spec.app.name}»: ${code}\nКод действует 5 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.\n${i.origin}`,
      action: "otp",
    },
  );
}

export interface OtpVerifyInput {
  challengeId: unknown;
  code: unknown;
  consent: unknown;
  ip: string | null;
}

/** Checks the code (a wrong one burns an attempt), then logs in; a missing consent keeps the code alive. */
export async function verifyOtp(deps: AuthDeps, sys: LoadedSystem, i: OtpVerifyInput): Promise<LoginResult> {
  const cid = typeof i.challengeId === "string" ? i.challengeId : "";
  const dot = cid.indexOf(".");
  const id = cid.slice(0, dot);
  if (dot < 0 || !/^[0-9a-f-]{36}$/.test(id)) throw new OtpError(422, "OTP_INVALID", INVALID);
  const sealed = deps.keys.unseal<Sealed>(cid.slice(dot + 1), aadOf(sys, id));
  if (!sealed || (sealed.c !== "email" && sealed.c !== "phone"))
    throw new OtpError(422, "OTP_INVALID", INVALID);
  const code = typeof i.code === "string" ? i.code.trim() : "";
  const now = deps.clock();
  const check = await sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const t = tx.sql`${tx.sql(sys.schema)}.${tx.sql("_w_otp")}`;
    const [row] = await tx.sql`
      select destination_hash, code_hash, attempts, expires_at from ${t} where id = ${id} for update`;
    if (!row || row.attempts >= OTP_MAX_ATTEMPTS || new Date(row.expires_at) <= now) return "dead" as const;
    const destHash = deps.keys.destination(`${sealed.c}:${sealed.d}`);
    if (!sameBytes(Buffer.from(row.destination_hash), destHash)) return "dead" as const;
    const ok =
      /^\d{6}$/.test(code) && sameBytes(Buffer.from(row.code_hash), deps.keys.otp([id, sealed.d, code]));
    if (ok) return "ok" as const;
    const [u] = await tx.sql`update ${t} set attempts = attempts + 1 where id = ${id} returning attempts`;
    return (u?.attempts ?? OTP_MAX_ATTEMPTS) >= OTP_MAX_ATTEMPTS ? ("dead" as const) : ("wrong" as const);
  });
  if (check === "dead") throw new OtpError(422, "OTP_INVALID", INVALID);
  if (check === "wrong") throw new OtpError(422, "OTP_INVALID", "Неверный код");
  const identity: Identity =
    sealed.c === "email" ? { kind: "email", email: sealed.d } : { kind: "phone", phone: sealed.d };
  return resolveLogin(
    sys,
    {
      identity,
      method: sealed.c === "email" ? "email_otp" : "phone_otp",
      role: sealed.r,
      consent: i.consent,
      ipHmac: deps.keys.ip(i.ip),
    },
    async (tx) => {
      const gone = await tx.sql`
        delete from ${tx.sql(sys.schema)}.${tx.sql("_w_otp")} where id = ${id} returning id`;
      if (gone.length === 0) throw new OtpError(422, "OTP_INVALID", INVALID);
    },
  );
}
