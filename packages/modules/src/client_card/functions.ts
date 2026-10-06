// Runtime functions of «Клиенты с историей» (sources of manifest.functions). The code is static, so it reads the
// contact fields of the source record through a plain object: the lead form may have phone, e-mail, both or neither.

/** File of clientFromLead. */
export const CLIENT_FROM_LEAD_FILE = "functions/client_card/clientFromLead.ts";

/**
 * clientFromLead (workflow client_from_lead, on_create lead): finds the client by the contact chosen in match_by
 * (falls back to the other contact when the lead has no such field), creates one when none matches and links the lead.
 * Idempotent: a lead that already has a client is left as is. create=false (the client has required extra fields the
 * lead cannot fill) — only an existing client is linked.
 */
export const CLIENT_FROM_LEAD = `// Module «Клиенты с историей»: a new lead finds or creates its client by contact and joins the client's history.
import { mutation, v } from "@wizard/sdk";

export default mutation({
  args: { id: v.id("lead"), matchBy: v.enum("phone", "email"), create: v.boolean() },
  handler: async (ctx, args) => {
    const lead = await ctx.db.lead.get(args.id);
    if (!lead) return { client: null };
    if (lead.client) return { client: lead.client };
    const doc = lead as unknown as Record<string, unknown>;
    const text = (key: string): string | null => {
      const value = doc[key];
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    };
    const phone = text("phone");
    const email = text("email")?.toLowerCase() ?? null;
    const order = args.matchBy === "email" ? ["email", "phone"] : ["phone", "email"];
    let client: { id: string } | null = null;
    for (const key of order) {
      if (client) break;
      if (key === "phone" && phone) client = await ctx.db.client.first({ where: { phone } });
      if (key === "email" && email) client = await ctx.db.client.first({ where: { email } });
    }
    if (!client && (!args.create || (!phone && !email))) return { client: null };
    const id = client
      ? client.id
      : await ctx.db.client.insert({ name: text("name") ?? "Без имени", phone, email } as never);
    await ctx.db.lead.patch(args.id, { client: id as never });
    return { client: id };
  },
});
`;
