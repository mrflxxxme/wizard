import { action, v } from "@wizard/sdk";

const fmt = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
});

// Запускается воркфлоу ticket_reminder за 24 часа до начала. Текст без ПДн:
// ни имени, ни телефона; chat_id по userId подставляет коннектор на стороне хоста.
export default action({
  args: { ticketId: v.id("ticket"), userId: v.id("users"), startsAt: v.datetime() },
  handler: async (ctx, { ticketId, userId, startsAt }) => {
    const res = await ctx.connectors.telegram.sendToUser({
      userId,
      text: `Напоминаем: форум «Северный ритейл» начнётся ${fmt.format(new Date(startsAt))}. Покажите QR-код билета на входе А.`,
      buttons: [{ text: "Открыть билет", url: `/ticket/${ticketId}` }],
      idempotencyKey: `reminder:${ticketId}`,
    });
    if (!res.delivered) ctx.log.info("reminder_skipped", { notLinked: res.reason === "not_linked" });
    return { delivered: res.delivered };
  },
});
