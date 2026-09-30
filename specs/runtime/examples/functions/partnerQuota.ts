import { query } from "@wizard/sdk";

// Партнёр видит только свою квоту: ctx.db применяет rowFilter роли (partner_user = $user.id).
// Организатор с той же функцией видит все квоты — его permission без rowFilter.
export default query({
  args: {},
  handler: async (ctx) => {
    const quotas = await ctx.db.partner_quota.list({ limit: 100 });
    return quotas.map((q) => ({
      id: q.id,
      company: q.company,
      promoCode: q.promo_code,
      total: q.total,
      used: q.used,
      left: Math.max(q.total - q.used, 0),
    }));
  },
});
