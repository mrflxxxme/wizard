// Runtime functions of «Воронка сделок» (sources of manifest.functions). Stages are canonical (stage_1…stage_N, won,
// lost), so the static code needs no parameters of the plan.

export const DEAL_FROM_LEAD_FILE = "functions/deals/dealFromLead.ts";
export const DEAL_FUNNEL_FILE = "functions/deals/dealFunnel.ts";

/**
 * dealFromLead (workflow deal_from_lead, lead → in_work): a deal on the first stage referring to the lead and, with
 * «Клиенты с историей», to the lead's client. Idempotent: one deal per lead. The title carries no personal data.
 */
export const DEAL_FROM_LEAD = `// Module «Воронка сделок»: a lead taken into work becomes a deal on the first stage.
import { mutation, v } from "@wizard/sdk";

export default mutation({
  args: { id: v.id("lead") },
  handler: async (ctx, args) => {
    const lead = await ctx.db.lead.get(args.id);
    if (!lead) return { deal: null };
    const existing = await ctx.db.deal.first({ where: { lead: lead.id } });
    if (existing) return { deal: existing.id };
    const day = ctx.now.toISOString().slice(0, 10).split("-").reverse().join(".");
    const doc: Record<string, unknown> = { title: \`Заявка от \${day}\`, status: "stage_1", lead: lead.id };
    const client = (lead as unknown as Record<string, unknown>).client;
    if (typeof client === "string" && client !== "") doc.client = client;
    const id = await ctx.db.deal.insert(doc as never);
    return { deal: id };
  },
});
`;

/**
 * dealFunnel (metric deals_stage_conversion): deals created in the period [from, to) (default — the last 30 days);
 * stages — the number of stages before won (the panel passes it from the spec; default — the furthest stage seen);
 * for each stage — how many reached it (are on it or further, won counts as the end of the funnel) and the share of
 * all deals of the period. value — the share that reached won, in percent. Lost deals count only for the first stage:
 * the stage they were lost at is not stored.
 */
export const DEAL_FUNNEL = `// Module «Воронка сделок»: conversion by stages for the goal panel.
import { query, v } from "@wizard/sdk";

const DAY = 24 * 60 * 60 * 1000;

export default query({
  args: {
    from: v.optional(v.datetime()),
    to: v.optional(v.datetime()),
    stages: v.optional(v.int({ min: 1, max: 20 })),
  },
  handler: async (ctx, args) => {
    const to = args.to ?? ctx.now.toISOString();
    const from = args.from ?? new Date(Date.parse(to) - 30 * DAY).toISOString();
    const deals = await ctx.db.deal.list({ where: { created_at: { gte: from, lt: to } }, limit: 1000 });
    const rank = (status: string): number => {
      if (status === "won") return Number.MAX_SAFE_INTEGER;
      const m = /^stage_(\\d+)$/.exec(status);
      return m ? Number(m[1]) : 1;
    };
    let last = args.stages ?? 1;
    for (const d of deals) {
      const r = rank(d.status);
      if (r !== Number.MAX_SAFE_INTEGER && r > last) last = r;
    }
    const total = deals.length;
    const share = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
    const stages: { stage: string; reached: number; share: number }[] = [];
    for (let k = 1; k <= last; k++) {
      const reached = k === 1 ? total : deals.filter((d) => d.status !== "lost" && rank(d.status) >= k).length;
      stages.push({ stage: \`stage_\${k}\`, reached, share: share(reached) });
    }
    const won = deals.filter((d) => d.status === "won").length;
    stages.push({ stage: "won", reached: won, share: share(won) });
    return { value: share(won), total, stages };
  },
});
`;
