// /admin «Пока не умею» (V3-06, D77 (12), api.yaml adminCapabilityShare): the monthly share of requirements the capability
// map of the v3 interview marked «пока не умею» (capabilityShareByMonth of V3-03 over the briefs: per system and month —
// its last brief version of that month). Months without briefs come as zeros so the series has no holes. Staff only
// (non-staff 404, no MFA 403 — staffGuard as the other /admin routes).
import { Hono } from "hono";
import { z } from "zod";
import { type StaffDeps, staffGuard } from "../abuse/staff.js";
import { capabilityShareByMonth } from "../agents/interview-v3-store.js";
import type { AppEnv } from "../http/auth.js";
import { parseQuery } from "../http/util.js";

/** At most this many months back (the default is twelve). */
export const CAPABILITY_MONTHS_MAX = 36;

/** YYYY-MM of `months` UTC months ending with the month of `now`, oldest first. */
export function monthRange(now: Date, months: number): string[] {
  return Array.from({ length: months }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1))
      .toISOString()
      .slice(0, 7),
  );
}

export function capabilityRoutes(d: StaffDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const staff = staffGuard(d);

  r.get("/admin/capability-share", staff, async (c) => {
    const q = parseQuery(
      c,
      z.object({ months: z.coerce.number().int().min(1).max(CAPABILITY_MONTHS_MAX).default(12) }),
    );
    const range = monthRange(d.now?.() ?? new Date(), q.months);
    const from = new Date(`${range[0]}-01T00:00:00Z`);
    const counted = new Map((await capabilityShareByMonth(d.db, { from })).map((m) => [m.month, m]));
    c.header("cache-control", "no-store");
    return c.json({
      months: range.map(
        (month) => counted.get(month) ?? { month, briefs: 0, requirements: 0, notYet: 0, share: 0 },
      ),
    });
  });

  return r;
}
