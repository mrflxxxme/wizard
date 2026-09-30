import { type ClientDoc, useEntityList, usePayment, useQuery } from "@wizard/sdk";
import { AppShell, Badge, ItemCard } from "@wizard/ui-kit";
import { dayLabel, FULFILLMENT, optionsText, rub, STATUS } from "./components/format";

type Order = ClientDoc<"cake_order">;

// Покупатель видит только свои заказы: rowFilter customer_user = $user.id применяет data API, не страница.
// Оплата — биндинги ЮKassa из AppSpec: «prepay» в статусе pending_payment, «final» — когда торт готов.
export default function MyOrders() {
  const orders = useEntityList("cake_order", { sort: "-created_at", limit: 50 });
  const slots = useQuery("freeSlots", { days: 60 });
  const payment = usePayment("yookassa");
  const dates = new Map(slots.data?.map((s) => [s.id, s.date]));

  const cta = (o: Order) => {
    if (o.status === "pending_payment") return { label: `Внести предоплату ${rub(o.prepay_amount)}`, pay: () => payment.pay("prepay", o.id) };
    if (o.status === "ready") return { label: `Доплатить ${rub(o.remaining_amount)}`, pay: () => payment.pay("final", o.id) };
    return { label: o.status === "completed" ? "Заказ выдан" : "Оплата не требуется", pay: null };
  };

  return (
    <AppShell title="Мои заказы">
      {!orders.isLoading && orders.items.length === 0 && <Badge tone="neutral">Заказов пока нет — соберите торт на главной</Badge>}
      {payment.error && <Badge tone="bad">{payment.error.details.message ?? "Не удалось перейти к оплате"}</Badge>}
      {orders.items.map((o) => {
        const action = cta(o);
        const date = dates.get(o.slot);
        return (
          <ItemCard
            key={o.id}
            id={o.id}
            title={`Заказ №${o.number}`}
            description={[
              optionsText(o.options),
              o.inscription ? `надпись «${o.inscription}»` : "",
              `${FULFILLMENT[o.fulfillment]}${date ? `, ${dayLabel(date)}` : ""}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            price={o.total}
            badge={{ text: STATUS[o.status].label, tone: STATUS[o.status].tone }}
            ctaLabel={action.label}
            disabled={!action.pay || payment.pending}
            onCta={() => void action.pay?.()}
          />
        );
      })}
    </AppShell>
  );
}
