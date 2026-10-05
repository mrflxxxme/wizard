// /admin «Запросы на развитие» (api.yaml adminDevelopmentRequests; D73, M2-59 mvp_scope): categories by frequency over
// 7 and 30 days and the latest requests with links to the system and the client. Staff only (non-staff 404, no MFA 403).
import { Hono } from "hono";
import { z } from "zod";
import { type StaffDeps, staffGuard } from "../abuse/staff.js";
import { DEVELOPMENT_CATEGORIES, developmentRequests } from "../gaps/service.js";
import type { AppEnv } from "../http/auth.js";
import { parseQuery } from "../http/util.js";

export function gapsRoutes(d: StaffDeps & { gapsNow?: (() => Date) | undefined }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const staff = staffGuard(d);

  r.get("/admin/development-requests", staff, async (c) => {
    const q = parseQuery(c, z.object({ category: z.enum(DEVELOPMENT_CATEGORIES).optional() }));
    const res = await developmentRequests(d.db, {
      now: d.gapsNow?.() ?? new Date(),
      category: q.category,
    });
    c.header("cache-control", "no-store");
    return c.json({
      categories: res.categories.map((x) => ({ ...x, lastAt: x.lastAt.toISOString() })),
      items: res.items.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
    });
  });

  return r;
}
