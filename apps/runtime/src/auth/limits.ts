// Cross-system OTP limits (runtime.yaml#auth.anti_abuse, platform/billing.yaml#plans.sms; L3-25): per destination
// over all systems 5/h and 10/day, per client network 20/h in a system, resend after 60 s, and the daily SMS budget
// of an org (Старт 100, Бизнес 300). Counters live in wz_runtime.otp_sends — one table for all systems, keyed by
// HMACs only (no contacts, no IPs).
import type postgres from "postgres";

export const OTP_LIMITS = {
  destinationPerHour: 5,
  destinationPerDay: 10,
  ipPerHour: 20,
  resendAfterSec: 60,
} as const;

export const SMS_DAILY_BUDGET: Readonly<Record<string, number>> = { start: 100, business: 300 };

const DDL = [
  "CREATE SCHEMA IF NOT EXISTS wz_runtime",
  `CREATE TABLE IF NOT EXISTS wz_runtime.otp_sends (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    destination_hmac bytea NOT NULL,
    system_id text NOT NULL,
    env text NOT NULL,
    channel text NOT NULL,
    ip_hmac bytea,
    org_key text,
    billable boolean NOT NULL DEFAULT false,
    sent_at timestamptz NOT NULL DEFAULT now()
  )`,
  "CREATE INDEX IF NOT EXISTS otp_sends_destination ON wz_runtime.otp_sends (destination_hmac, sent_at)",
  "CREATE INDEX IF NOT EXISTS otp_sends_ip ON wz_runtime.otp_sends (system_id, ip_hmac, sent_at)",
  "CREATE INDEX IF NOT EXISTS otp_sends_org ON wz_runtime.otp_sends (org_key, sent_at) WHERE billable",
];

export type LimitVerdict =
  | { ok: true }
  | { ok: false; code: "RATE_LIMITED" | "OTP_BUDGET_EXCEEDED"; retryAfterSec: number; reason: string };

export interface OtpSend {
  destination: Buffer;
  systemId: string;
  env: string;
  channel: "email" | "phone";
  ip: Buffer | null;
  /** Org of the system for the SMS budget; billable sends only. */
  orgKey: string | null;
  /** A real SMS (prod): counts against the org budget. */
  billable: boolean;
  /** Budget of the org's plan per day (billable only). */
  dailyBudget: number;
}

export interface OtpLimiter {
  /** Checks every limit and records the send in one transaction; nothing is recorded when a limit is hit. */
  admit(send: OtpSend, now: Date): Promise<LimitVerdict>;
}

/**
 * Store over the runtime's own connection (not a system role): the schema is created on first use by whoever the
 * runtime connects as locally; in the cloud the migration job creates it and grants DML to the runtime role.
 */
export function pgOtpLimiter(sql: postgres.Sql): OtpLimiter {
  let ready: Promise<void> | null = null;
  const ensure = () => {
    ready ??= sql
      .begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('wz_runtime.otp_sends'))`;
        for (const s of DDL) await tx.unsafe(s);
      })
      .then(() => undefined)
      .catch((e) => {
        ready = null;
        throw e;
      });
    return ready;
  };

  return {
    async admit(s, now) {
      await ensure();
      return sql.begin(async (tx) => {
        const at = now.toISOString();
        // Serialise sends to one destination (and one org budget) across runtime processes.
        await tx`select pg_advisory_xact_lock(hashtext(${`otp:${s.destination.toString("hex")}`}))`;
        if (s.billable && s.orgKey)
          await tx`select pg_advisory_xact_lock(hashtext(${`otp-org:${s.orgKey}`}))`;
        const [d] = await tx`
          select
            count(*) filter (where sent_at > ${at}::timestamptz - interval '1 hour')::int as hour,
            count(*)::int as day,
            min(sent_at) filter (where sent_at > ${at}::timestamptz - interval '1 hour') as first_hour,
            min(sent_at) as first_day,
            max(sent_at) filter (where system_id = ${s.systemId} and env = ${s.env}) as last_here
          from wz_runtime.otp_sends
          where destination_hmac = ${s.destination} and sent_at > ${at}::timestamptz - interval '1 day'`;
        const ms = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).getTime();
        const sec = (from: unknown, windowSec: number) =>
          Math.max(1, Math.ceil(windowSec - (now.getTime() - ms(from)) / 1000));
        if (d?.last_here && now.getTime() - ms(d.last_here) < OTP_LIMITS.resendAfterSec * 1000)
          return deny("RATE_LIMITED", sec(d.last_here, OTP_LIMITS.resendAfterSec), "resend");
        if ((d?.hour ?? 0) >= OTP_LIMITS.destinationPerHour)
          return deny("RATE_LIMITED", sec(d?.first_hour, 3600), "destination_hour");
        if ((d?.day ?? 0) >= OTP_LIMITS.destinationPerDay)
          return deny("RATE_LIMITED", sec(d?.first_day, 86400), "destination_day");
        if (s.ip) {
          const [i] = await tx`
            select count(*)::int as n, min(sent_at) as first from wz_runtime.otp_sends
            where system_id = ${s.systemId} and ip_hmac = ${s.ip}
              and sent_at > ${at}::timestamptz - interval '1 hour'`;
          if ((i?.n ?? 0) >= OTP_LIMITS.ipPerHour)
            return deny("RATE_LIMITED", sec(i?.first, 3600), "ip_hour");
        }
        if (s.billable && s.orgKey) {
          const [o] = await tx`
            select count(*)::int as n from wz_runtime.otp_sends
            where org_key = ${s.orgKey} and billable and sent_at >= date_trunc('day', ${at}::timestamptz)`;
          if ((o?.n ?? 0) >= s.dailyBudget) {
            const nextDay = new Date(now);
            nextDay.setUTCHours(24, 0, 0, 0);
            const wait = Math.max(1, Math.ceil((nextDay.getTime() - now.getTime()) / 1000));
            return deny("OTP_BUDGET_EXCEEDED", wait, "org_budget");
          }
        }
        await tx`
          insert into wz_runtime.otp_sends
            (destination_hmac, system_id, env, channel, ip_hmac, org_key, billable, sent_at)
          values (${s.destination}, ${s.systemId}, ${s.env}, ${s.channel}, ${s.ip}, ${s.orgKey}, ${s.billable}, ${at})`;
        // Counters older than a day are useless; trim a little on every send.
        await tx`
          delete from wz_runtime.otp_sends where id in (
            select id from wz_runtime.otp_sends where sent_at < ${at}::timestamptz - interval '2 days' limit 100)`;
        return { ok: true } as const;
      });
    },
  };
}

function deny(
  code: "RATE_LIMITED" | "OTP_BUDGET_EXCEEDED",
  retryAfterSec: number,
  reason: string,
): LimitVerdict {
  return { ok: false, code, retryAfterSec, reason };
}
