import { type ClientDoc, useQuery, useState } from "@wizard/sdk";
import { AppShell, Button, RecordCard, StatsReport, StatusBoard } from "@wizard/ui-kit";
import { dayLabel, FULFILLMENT, optionsText } from "./components/format";

type Order = ClientDoc<"cake_order">;

// Доска производства: перенос между колонками — update status с правами роли (у кондитера суммы, состав
// и контакты заказа — readonly). Уведомления «принят»/«готов» шлют воркфлоу order_prepaid/order_ready.
export default function Production() {
  const slots = useQuery("freeSlots", { days: 14 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const days = slots.data ?? [];
  const dates = new Map(days.map((s) => [s.id, s.date]));
  const sum = (k: "capacity" | "taken" | "free") => days.reduce((n, s) => n + s[k], 0);

  return (
    <AppShell title="Производство">
      <StatsReport
        title="Загрузка на две недели"
        data={{
          kpis: [
            { id: "taken", label: "Тортов в заказах", value: sum("taken"), total: sum("capacity"), format: "int" },
            { id: "free", label: "Свободных мест", value: sum("free"), format: "int" },
          ],
          bars: {
            title: "По дням",
            items: days.filter((s) => !s.closed).map((s) => ({ label: dayLabel(s.date), value: s.taken, max: s.capacity })),
          },
        }}
      />
      <StatusBoard
        entity="cake_order"
        statusField="status"
        columns={["prepaid", "in_production", "ready", "completed"]}
        card={(o: Order) => {
          const date = dates.get(o.slot);
          return {
            title: `№${o.number} · ${optionsText(o.options)}`,
            subtitle: o.inscription ? `Надпись: «${o.inscription}»` : undefined,
            meta: `${FULFILLMENT[o.fulfillment]}${date ? ` · к ${dayLabel(date)}` : ""}`,
          };
        }}
        onCardClick={(o: Order) => setSelectedId(o.id)}
        limitPerColumn={30}
      />
      {selectedId && (
        <>
          <RecordCard
            entity="cake_order"
            id={selectedId}
            fields={["number", "status", "inscription", "note", "fulfillment", "address", "customer_name", "customer_phone", "total", "remaining_amount"]}
            title={(o: Order) => `Заказ №${o.number}`}
            actions={[
              { id: "start", label: "Взять в работу", tone: "primary", kind: "update", patch: { status: "in_production" }, visible: (o: Order) => o.status === "prepaid" },
              { id: "ready", label: "Готов к выдаче", tone: "primary", kind: "update", patch: { status: "ready" }, visible: (o: Order) => o.status === "in_production" },
              {
                id: "handed",
                label: "Выдан, доплата получена",
                kind: "update",
                patch: { status: "completed" },
                confirm: "Покупатель доплатил на месте и забрал заказ?",
                visible: (o: Order) => o.status === "ready",
              },
            ]}
          />
          <Button variant="ghost" onClick={() => setSelectedId(null)}>
            Закрыть
          </Button>
        </>
      )}
    </AppShell>
  );
}
