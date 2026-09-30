import { type Id, useEntityList, useMutation, useNavigate, usePayment, useQuery, useState, useUser } from "@wizard/sdk";
import { AppShell, Badge, Button, Catalog, Field, ItemCard } from "@wizard/ui-kit";

export default function Landing() {
  const { user, login } = useUser();
  const types = useQuery("ticketAvailability", {});
  const quota = useQuery("partnerQuota", user?.role === "partner" ? {} : "skip");
  const [picked, setPicked] = useState<Id<"ticket_type"> | null>(null);

  const choose = (id: Id<"ticket_type">) => (user ? setPicked(id) : login({ role: "participant", returnTo: "/" }));

  return (
    <AppShell title="Форум «Северный ритейл»" subtitle="14–15 ноября · Казань · 600 участников">
      {quota.data?.map((q) => (
        <Badge key={q.id} tone="info">{`Квота ${q.company}: ${q.used} из ${q.total}, промокод ${q.promoCode}`}</Badge>
      ))}
      <Catalog title="Билеты" loading={types.isLoading} error={types.error?.details.message}>
        {types.data?.map((t) => (
          <ItemCard
            key={t.id}
            title={t.name}
            description={t.description ?? undefined}
            price={t.kind === "partner" ? undefined : t.price}
            badge={<Badge tone={t.left < 20 ? "danger" : "neutral"}>{`Осталось ${t.left}`}</Badge>}
            action={
              <Button disabled={t.left === 0} onClick={() => choose(t.id)}>
                {t.kind === "partner" ? "Ввести код" : "Выбрать"}
              </Button>
            }
          />
        ))}
      </Catalog>
      {picked && <RegisterForm ticketTypeId={picked} onCancel={() => setPicked(null)} />}
    </AppShell>
  );
}

function RegisterForm({ ticketTypeId, onCancel }: { ticketTypeId: Id<"ticket_type">; onCancel: () => void }) {
  const streams = useEntityList("stream", { sort: "name" });
  const [register, reg] = useMutation("registerTicket");
  const payment = usePayment("yookassa");
  const navigate = useNavigate();
  const [form, setForm] = useState({ streamId: "", holderName: "", holderEmail: "", promoCode: "" });
  const set = (k: keyof typeof form) => (value: string) => setForm({ ...form, [k]: value });

  const submit = async () => {
    const res = await register({
      ticketTypeId,
      streamId: form.streamId as Id<"stream">,
      holderName: form.holderName,
      holderEmail: form.holderEmail,
      promoCode: form.promoCode || undefined,
    });
    if (res.needsPayment) await payment.pay("ticket", res.ticketId);
    else navigate(`/ticket/${res.ticketId}`);
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Поток" type="select" required value={form.streamId} onChange={set("streamId")}
        options={streams.items.map((s) => ({ value: s.id, label: s.name }))} />
      <Field label="ФИО" required value={form.holderName} onChange={set("holderName")} />
      <Field label="Email" type="email" required value={form.holderEmail} onChange={set("holderEmail")} />
      <Field label="Промокод партнёра" value={form.promoCode} onChange={set("promoCode")} />
      {reg.error && <Badge tone="danger">{reg.error.details.message ?? "Не удалось оформить билет"}</Badge>}
      <Button type="submit" loading={reg.pending || payment.pending}>Оформить</Button>
      <Button variant="ghost" onClick={onCancel}>Отмена</Button>
    </form>
  );
}
