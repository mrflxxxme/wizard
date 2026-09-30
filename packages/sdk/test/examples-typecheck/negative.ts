// Negative type cases: every `@ts-expect-error` line MUST fail tsc against the forum registry,
// otherwise tsc reports TS2578 (unused directive) and the examples typecheck test fails.
import {
  action,
  type ClientDoc,
  type Id,
  mutation,
  query,
  useEntity,
  useEntityList,
  useEntityMutation,
  useMutation,
  usePayment,
  useQuery,
  v,
} from "@wizard/sdk";

const streamId = "00000001-0000-4000-8000-000000000000" as Id<"stream">;
const ticketId = "00000002-0000-4000-8000-000000000000" as Id<"ticket">;

export const whereCases = query({
  args: {},
  handler: async (ctx) => {
    // @ts-expect-error `status` alone is not a prefix of any ticket index (G0-IDX-01)
    await ctx.db.ticket.list({ where: { status: "paid" } });
    // @ts-expect-error skipping `status` in [stream, status, created_at]
    await ctx.db.ticket.count({ where: { stream: streamId, created_at: { gte: "2026-01-01" } } });
    // @ts-expect-error ref keys take exact ids, not ranges
    await ctx.db.ticket.list({ where: { stream: { gte: streamId }, status: "paid" } });
    // @ts-expect-error `{}` is not an index prefix
    await ctx.db.ticket.count({ where: {} });
    // @ts-expect-error `company` is not indexed on ticket
    await ctx.db.ticket.first({ where: { company: "Альфа" } });
    // @ts-expect-error enum value outside the field's enum
    await ctx.db.ticket.list({ where: { stream: streamId, status: "lost" } });
    // @ts-expect-error `description` is not indexed on stream
    await ctx.db.stream.list({ where: { description: "x" } });
    return null;
  },
});

export const idCases = query({
  args: {},
  handler: async (ctx) => {
    // @ts-expect-error plain string instead of Id<"stream">
    await ctx.db.stream.get("00000001-0000-4000-8000-000000000000");
    // @ts-expect-error Id of another entity
    await ctx.db.stream.get(ticketId);
    // @ts-expect-error unknown entity
    await ctx.db.unknown_entity.list();
    // @ts-expect-error `users` is a system entity, not in ctx.db
    await ctx.db.users.list();
    // @ts-expect-error getBy only on unique fields
    await ctx.systemDb.partner_quota.getBy("company", "Альфа");
    // @ts-expect-error query ctx is read-only
    await ctx.db.stream.insert({ name: "x", capacity: 1 });
    // @ts-expect-error scheduler is not available in queries
    await ctx.scheduler.runAfter(0, "sendReminder", { ticketId, userId: ctx.user.id, startsAt: "" });
    const t = await ctx.db.ticket.get(ticketId);
    // @ts-expect-error optional fields are `T | null` in Doc
    const phone: string | undefined = t?.holder_phone;
    return phone;
  },
});

export const writeCases = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    // @ts-expect-error required field `capacity` missing
    await ctx.db.stream.insert({ name: args.name });
    // @ts-expect-error unknown field
    await ctx.db.stream.insert({ name: args.name, capacity: 1, color: "red" });
    // @ts-expect-error system fields are not writable
    await ctx.db.stream.patch(streamId, { created_at: "2026-01-01T00:00:00Z" });
    // @ts-expect-error wrong field type
    await ctx.db.stream.patch(streamId, { capacity: "10" });
    // @ts-expect-error unknown function name
    await ctx.scheduler.runAfter(1000, "noSuchFunction", {});
    // @ts-expect-error args of sendReminder require ticketId
    await ctx.scheduler.runAfter(1000, "sendReminder", { startsAt: "2026-01-01T00:00:00Z" });
    // @ts-expect-error connectors are available in actions only
    await ctx.connectors.telegram.sendToUser({ userId: ctx.user.id, text: "x" });
    // @ts-expect-error app error details are JSON
    throw ctx.error("BAD_THING", { message: "Ошибка", when: new Date() });
  },
});

export const actionCases = action({
  args: {},
  handler: async (ctx) => {
    // @ts-expect-error actions have no direct db access
    await ctx.db.stream.list();
    // @ts-expect-error runQuery accepts query names only
    await ctx.runQuery("registerTicket", {});
    // @ts-expect-error unknown integration
    await ctx.connectors.whatsapp.send({});
    // @ts-expect-error recipients are userIds, not phone numbers
    await ctx.connectors.telegram.sendToUser({ phone: "+79990000000", text: "x" });
    // @ts-expect-error log fields: numbers, booleans and null only
    ctx.log.info("x", { name: "Анна" });
    return null;
  },
});

// @ts-expect-error unknown entity in a validator
export const badValidator = v.id("nope");

export function ClientCases() {
  // @ts-expect-error mutation name in useQuery
  useQuery("registerTicket", {});
  // @ts-expect-error args are required ("skip" disables the query)
  useQuery("ticketAvailability");
  const [register] = useMutation("registerTicket");
  // @ts-expect-error plain string instead of Id<"stream">
  void register({ ticketTypeId: "a" as Id<"ticket_type">, streamId: "b", holderName: "Анна", holderEmail: "a@b.c" });
  // @ts-expect-error consent is the literal `true`
  void register({ ticketTypeId: "a" as Id<"ticket_type">, streamId, holderName: "А", holderEmail: "e" }, { consent: false });
  // @ts-expect-error queries are not mutations
  useMutation("partnerQuota");
  // @ts-expect-error unknown entity
  useEntityList("unknown_entity");
  // @ts-expect-error filter by a field that does not exist
  useEntityList("stream", { filter: { color: "red" } });
  // @ts-expect-error sort key must be a field
  useEntityList("stream", { sort: "-color" });
  const t = useEntity("ticket", ticketId);
  // @ts-expect-error field hidden for some role → optional in ClientDoc
  const name: string = (t.data as ClientDoc<"ticket">).holder_name;
  const m = useEntityMutation("stream");
  // @ts-expect-error insert shape is checked
  void m.create({ name: 1, capacity: 1 });
  // @ts-expect-error payment binding must be declared in integration config
  void usePayment("yookassa").pay("order", "x");
  // @ts-expect-error only yookassa integrations accept payments
  usePayment("telegram");
  return name;
}
