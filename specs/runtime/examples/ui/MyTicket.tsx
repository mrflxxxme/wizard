import { useEntity, useParams } from "@wizard/sdk";
import { AppShell, Badge, QrTicket } from "@wizard/ui-kit";

export default function MyTicket() {
  const { id } = useParams<{ id: string }>();
  const ticket = useEntity("ticket", id);
  const t = ticket.data;
  return (
    <AppShell title="Мой билет">
      {t && (t.status === "paid" || t.status === "issued") ? (
        <QrTicket integration="qr" entity="ticket" id={t.id} title="Форум «Северный ритейл»" caption="Покажите QR на входе А · работает без интернета" />
      ) : (
        <Badge tone="warning">{t ? "Билет ещё не оплачен" : "Загрузка…"}</Badge>
      )}
    </AppShell>
  );
}
