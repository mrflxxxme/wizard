import { type ClientDoc, type Id, useEntityList, useMutation, useNavigate, usePayment, useQuery, useState, useUser } from "@wizard/sdk";
import { AppShell, Badge, Button, Catalog, Field } from "@wizard/ui-kit";

type TicketType = ClientDoc<"ticket_type">;

export default function Landing() {
  const { user, login } = useUser();
  const availability = useQuery("ticketAvailability", {});
  const quota = useQuery("partnerQuota", user?.role === "partner" ? {} : "skip");
  const [picked, setPicked] = useState<Id<"ticket_type"> | null>(null);
  const left = new Map(availability.data?.map((t) => [t.id, t.left]));

  return (
    <AppShell>
      {quota.data?.map((q) => (
        <Badge key={q.id} tone="accent">{`Квота «${q.company}»: ${q.used} из ${q.total}, промокод ${q.promoCode}`}</Badge>
      ))}
      <Catalog
        entity="ticket_type"
        query={{ filter: { active: true }, sort: { field: "price", dir: "asc" } }}
        map={(t: TicketType) => ({
          id: t.id,
          title: t.name,
          description: t.description ?? undefined,
          price: t.kind === "partner" ? null : t.price,
          priceText: "по промокоду",
          remaining: left.get(t.id) ?? null,
        })}
        onSelect={(t: TicketType) => (user ? setPicked(t.id) : login({ role: "participant", next: "/" }))}
      />
      {picked && <RegisterForm ticketTypeId={picked} onCancel={() => setPicked(null)} />}
    </AppShell>
  );
}

// Форма без RecordForm: билет создаёт функция registerTicket (лимиты, промокод), а не data API.
// Согласие на ПДн: отдельный неотмеченный чекбокс; факт согласия уходит в runtime через { consent: true }.
function RegisterForm({ ticketTypeId, onCancel }: { ticketTypeId: Id<"ticket_type">; onCancel: () => void }) {
  const streams = useEntityList("stream", { sort: "name" });
  const [register, reg] = useMutation("registerTicket");
  const payment = usePayment("yookassa");
  const navigate = useNavigate();
  const [form, setForm] = useState({ streamId: "", holderName: "", holderEmail: "", promoCode: "", consent: false });
  const set = (k: keyof typeof form) => (v: unknown) => setForm({ ...form, [k]: v });

  const submit = async () => {
    const res = await register(
      {
        ticketTypeId,
        streamId: form.streamId as Id<"stream">,
        holderName: form.holderName,
        holderEmail: form.holderEmail,
        promoCode: form.promoCode || undefined,
      },
      { consent: true },
    );
    if (res.needsPayment) await payment.pay("ticket", res.ticketId);
    else navigate(`/ticket/${res.ticketId}`);
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (form.consent) void submit(); }}>
      <Field name="streamId" label="Поток" type="enum" required value={form.streamId} onChange={set("streamId")}
        enumOptions={streams.items.map((s) => ({ value: s.id, label: s.name }))} />
      <Field name="holderName" label="ФИО" type="string" required value={form.holderName} onChange={set("holderName")} />
      <Field name="holderEmail" label="Email" type="email" required value={form.holderEmail} onChange={set("holderEmail")} />
      <Field name="promoCode" label="Промокод партнёра" type="string" value={form.promoCode} onChange={set("promoCode")} />
      <Field name="consent" label="Согласен на обработку персональных данных по политике конфиденциальности" type="bool" required value={form.consent} onChange={set("consent")} />
      {reg.error && <Badge tone="bad">{reg.error.details.message ?? "Не удалось оформить билет"}</Badge>}
      <Button type="submit" variant="primary" loading={reg.pending || payment.pending} disabled={!form.consent}>Оформить</Button>
      <Button variant="ghost" onClick={onCancel}>Отмена</Button>
    </form>
  );
}
