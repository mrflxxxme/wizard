// Positive type contract (sdk.md §5/§6) against the registry generated from forum.json.
import {
  type ActionName,
  type ClientDoc,
  type ClientUser,
  type Connectors,
  type Doc,
  type EntityName,
  type FnArgs,
  type FnResult,
  type Id,
  type IndexWhere,
  type Infer,
  type Insert,
  type MutationName,
  mutation,
  type Page,
  type Patch,
  type Payments,
  type QueryName,
  type QueryState,
  query,
  type RoleName,
  type TelegramConnector,
  useEntity,
  useEntityList,
  useEntityMutation,
  useMutation,
  useQuery,
  useState,
  useUser,
  v,
  type WizardError,
} from "@wizard/sdk";
import { expectTypeOf } from "vitest";

expectTypeOf<EntityName>().toEqualTypeOf<
  "stream" | "ticket_type" | "ticket" | "speaker_application" | "partner_quota" | "session" | "checkin" | "payment"
>();
expectTypeOf<RoleName>().toEqualTypeOf<
  "organizer" | "moderator" | "speaker" | "partner" | "participant" | "volunteer" | "visitor"
>();
expectTypeOf<QueryName>().toEqualTypeOf<"ticketAvailability" | "partnerQuota">();
expectTypeOf<MutationName>().toEqualTypeOf<"registerTicket">();
expectTypeOf<ActionName>().toEqualTypeOf<"sendReminder">();
expectTypeOf<Payments["yookassa"]>().toEqualTypeOf<"ticket">();
expectTypeOf<Connectors["telegram"]>().toEqualTypeOf<TelegramConnector>();

// Field mapping (sdk.md §4).
expectTypeOf<Doc<"ticket">["status"]>().toEqualTypeOf<
  "pending_payment" | "paid" | "issued" | "canceled" | "refunded"
>();
expectTypeOf<Doc<"ticket">["stream"]>().toEqualTypeOf<Id<"stream">>();
expectTypeOf<Doc<"ticket">["holder_user"]>().toEqualTypeOf<Id<"users">>();
expectTypeOf<Doc<"ticket">["holder_phone"]>().toEqualTypeOf<string | null>();
expectTypeOf<Doc<"ticket">["amount"]>().toEqualTypeOf<number>();
expectTypeOf<Doc<"ticket_type">["active"]>().toEqualTypeOf<boolean | null>();
expectTypeOf<Doc<"ticket">["id"]>().toEqualTypeOf<Id<"ticket">>();
expectTypeOf<Doc<"ticket">["created_by"]>().toEqualTypeOf<Id<"users"> | null>();
expectTypeOf<Insert<"ticket_type">>().toHaveProperty("active");
expectTypeOf<{ name: string; kind: "vip"; price: number; capacity: number }>().toExtend<Insert<"ticket_type">>();
expectTypeOf<{ used: number }>().toExtend<Patch<"partner_quota">>();
expectTypeOf<ClientDoc<"ticket">["holder_name"]>().toEqualTypeOf<string | undefined>();
expectTypeOf<ClientDoc<"ticket">["status"]>().toEqualTypeOf<Doc<"ticket">["status"]>();
expectTypeOf<ClientDoc<"speaker_application">["phone"]>().toEqualTypeOf<string | null | undefined>();

// Index prefixes (sdk.md §2.4).
expectTypeOf<{ stream: Id<"stream"> }>().toExtend<IndexWhere<"ticket">>();
expectTypeOf<{ stream: Id<"stream">; status: "paid" }>().toExtend<IndexWhere<"ticket">>();
expectTypeOf<{ stream: Id<"stream">; status: "paid"; created_at: { gte: string } }>().toExtend<
  IndexWhere<"ticket">
>();
expectTypeOf<{ holder_user: Id<"users"> }>().toExtend<IndexWhere<"ticket">>();
expectTypeOf<{ created_at: { lt: string } }>().toExtend<IndexWhere<"stream">>();
expectTypeOf<{ starts_at: { gte: string; lt: string } }>().toExtend<IndexWhere<"session">>();
expectTypeOf<{ promo_code: string }>().toExtend<IndexWhere<"partner_quota">>();
expectTypeOf<{ status: "paid" }>().not.toExtend<IndexWhere<"ticket">>();
expectTypeOf<Record<string, never>>().not.toExtend<IndexWhere<"ticket">>();

// Functions registry.
expectTypeOf<FnArgs<"registerTicket">>().toEqualTypeOf<
  {
    ticketTypeId: Id<"ticket_type">;
    streamId: Id<"stream">;
    holderName: string;
    holderEmail: string;
  } & { holderPhone?: string | undefined; promoCode?: string | undefined }
>();
expectTypeOf<FnResult<"registerTicket">>().toEqualTypeOf<{ ticketId: Id<"ticket">; needsPayment: boolean }>();
expectTypeOf<FnResult<"partnerQuota">[number]["promoCode"]>().toEqualTypeOf<string>();
expectTypeOf<FnResult<"sendReminder">>().toEqualTypeOf<{ delivered: boolean }>();

// Validators.
expectTypeOf<Infer<ReturnType<typeof v.enum<["a", "b"]>>>>().toEqualTypeOf<"a" | "b">();
const lit = v.literal(3);
expectTypeOf<Infer<typeof lit>>().toEqualTypeOf<3>();
const nested = v.object({ a: v.array(v.id("stream")), b: v.optional(v.nullable(v.money())) });
expectTypeOf<Infer<typeof nested>>().toEqualTypeOf<
  { a: Id<"stream">[] } & { b?: number | null | undefined }
>();

// Definitions: handler ctx and pagination.
export const paged = query({
  args: { page: v.pagination() },
  handler: async (ctx, { page }) => {
    const res = await ctx.db.session.paginate({ where: { stream: "x" as Id<"stream"> }, order: "desc" }, page);
    expectTypeOf(res).toEqualTypeOf<Page<Doc<"session">>>();
    expectTypeOf(await ctx.systemDb.partner_quota.getBy("promo_code", "ALFA10")).toEqualTypeOf<Doc<"partner_quota"> | null>();
    expectTypeOf(ctx.user.role).toEqualTypeOf<RoleName | "__system">();
    return res.items.length;
  },
});
export const scheduled = mutation({
  args: { id: v.id("ticket") },
  handler: async (ctx, { id }) => {
    const t = await ctx.db.ticket.get(id);
    if (!t) throw ctx.error("NOT_FOUND", { message: "Нет билета" });
    const job = await ctx.scheduler.runAfter(60_000, "sendReminder", {
      ticketId: id,
      userId: t.holder_user,
      startsAt: t.event_starts_at,
    });
    await ctx.scheduler.cancel(job);
    await ctx.db.ticket.patch(id, { status: "canceled" });
    return job;
  },
});

// Client hooks.
export function ClientContract() {
  const q = useQuery("ticketAvailability", {});
  expectTypeOf(q).toEqualTypeOf<QueryState<FnResult<"ticketAvailability">>>();
  expectTypeOf(q.error).toEqualTypeOf<WizardError | undefined>();
  const [run, state] = useMutation("registerTicket");
  expectTypeOf(run).returns.resolves.toEqualTypeOf<{ ticketId: Id<"ticket">; needsPayment: boolean }>();
  expectTypeOf(state.pending).toEqualTypeOf<boolean>();
  const list = useEntityList("ticket", { filter: { status: { in: ["paid", "issued"] } }, sort: ["-created_at", "amount"] });
  expectTypeOf(list.items).toEqualTypeOf<ClientDoc<"ticket">[]>();
  const one = useEntity("stream", "any-string-id");
  expectTypeOf(one.data).toEqualTypeOf<ClientDoc<"stream"> | null | undefined>();
  const m = useEntityMutation("stream");
  expectTypeOf(m.create).returns.resolves.toEqualTypeOf<ClientDoc<"stream">>();
  const { user } = useUser();
  expectTypeOf(user).toEqualTypeOf<ClientUser | null>();
  const [n] = useState(0);
  return n;
}
