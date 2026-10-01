// Mail-related abuse limits of a system (L3-29): host names that look like mail/infrastructure services and the
// invitation quota (runtime.yaml#routing.system_slug, #auth.role_assignment).
import { consumeQuota } from "./runtime.js";
import type { ConnectorCtx } from "./types.js";

export const RESERVED_SYSTEM_SLUGS: ReadonlySet<string> = new Set([
  "www",
  "mail",
  "smtp",
  "mx",
  "mta-sts",
  "autodiscover",
  "autoconfig",
  "api",
  "admin",
  "status",
  "static",
  "cdn",
  "abuse",
  "security",
  "wizard",
]);

export function isReservedSystemSlug(slug: string): boolean {
  return RESERVED_SYSTEM_SLUGS.has(slug.toLowerCase());
}

/** Invitations a day per system: Free — 5, other plans — 20. */
export const INVITES_PER_DAY = { free: 5, paid: 20 } as const;

/** Counts one invitation; over the daily quota → ConnectorError RATE_LIMITED. */
export async function consumeInviteQuota(ctx: Pick<ConnectorCtx, "store" | "now" | "system">): Promise<void> {
  const limit = INVITES_PER_DAY[ctx.system.plan ?? "free"];
  await consumeQuota(
    ctx,
    "invites_day",
    limit,
    24 * 60 * 60_000,
    `Не больше ${limit} приглашений в сутки — попробуйте завтра`,
  );
}
