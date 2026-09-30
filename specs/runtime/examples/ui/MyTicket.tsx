import { useEntity, useParams } from "@wizard/sdk";
import { AppShell, Badge, QrTicket } from "@wizard/ui-kit";

export default function MyTicket() {
  const { id } = useParams<{ id: string }>();
  const { data: ticket, isLoading } = useEntity("ticket", id);
  const valid = ticket?.status === "paid" || ticket?.status === "issued";

  return (
    <AppShell title="Мой билет">
      {valid ? (
        <QrTicket
          entity="ticket"
          id={id}
          tokenField="qr_token"
          title="Форум «Северный ритейл»"
          subtitle="14 ноября · 09:30 · Казань"
          hint="Покажите QR на входе А · работает без интернета"
        />
      ) : (
        <Badge tone="warn">{isLoading ? "Загружаем билет…" : "Билет ещё не оплачен"}</Badge>
      )}
    </AppShell>
  );
}
