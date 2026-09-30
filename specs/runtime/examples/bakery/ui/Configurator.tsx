import { type ClientDoc, type Id, useEntityList, useMutation, usePayment, useQuery, useState, useUser } from "@wizard/sdk";
import { AppShell, Badge, Button, Catalog, ConsentCheckbox, Field, ItemCard } from "@wizard/ui-kit";
import { dayLabel, rub } from "./components/format";

type Product = ClientDoc<"product">;
type Group = ClientDoc<"product_option">["option_group"];
type Selection = Record<string, string[]>;

const GROUPS: { id: Group; label: string; kind: "single" | "multi"; required: boolean }[] = [
  { id: "weight", label: "Вес", kind: "single", required: true },
  { id: "filling", label: "Начинка", kind: "single", required: true },
  { id: "decor", label: "Декор", kind: "multi", required: false },
];

export default function Configurator() {
  const [product, setProduct] = useState<Product | null>(null);
  return (
    <AppShell>
      {product ? (
        <CakeBuilder product={product} onBack={() => setProduct(null)} />
      ) : (
        <Catalog
          entity="product"
          query={{ filter: { active: true }, sort: { field: "name", dir: "asc" } }}
          map={(p: Product) => ({
            id: p.id,
            title: p.name,
            description: p.description ?? undefined,
            price: null,
            priceText: "цена зависит от веса и декора",
          })}
          onSelect={(p: Product) => setProduct(p)}
          emptyText="Скоро здесь появятся торты"
        />
      )}
    </AppShell>
  );
}

// Опции — из product_option этого изделия; итог и предоплата — только из calcPrice (сервер), не из суммы чипов.
function CakeBuilder({ product, onBack }: { product: Product; onBack: () => void }) {
  const { user, login } = useUser();
  const options = useEntityList("product_option", {
    filter: { product: product.id, active: true },
    sort: ["option_group", "sort_order"],
    limit: 100,
  });
  const [selection, setSelection] = useState<Selection>({});
  const [ordering, setOrdering] = useState(false);
  const optionIds = Object.values(selection).flat() as Id<"product_option">[];
  const price = useQuery("calcPrice", { productId: product.id, optionIds });
  const ready = price.data !== undefined && price.data.missing.length === 0;

  const optionGroups = GROUPS.map((g) => ({
    ...g,
    choices: options.items
      .filter((o) => o.option_group === g.id)
      .map((o) => ({ id: o.id, label: o.title, priceDelta: o.price })),
  })).filter((g) => g.choices.length > 0);

  return (
    <>
      <ItemCard
        id={product.id}
        title={product.name}
        description={product.description ?? undefined}
        price={null}
        priceText={price.data ? `Предоплата 50%: ${rub(price.data.prepay)}` : "Соберите торт"}
        optionGroups={optionGroups}
        selection={selection}
        onSelectionChange={(s: Selection) => {
          setSelection(s);
          setOrdering(false);
        }}
        total={price.data?.total}
        ctaLabel="Оформить предзаказ"
        disabled={!ready}
        onCta={() => (user ? setOrdering(true) : login({ role: "customer", next: "/" }))}
      />
      {price.error && <Badge tone="bad">{price.error.details.message ?? "Не удалось посчитать цену"}</Badge>}
      {ordering && user && user.role !== "customer" && (
        <Badge tone="warn">Заказ оформляет покупатель: войдите под его учётной записью</Badge>
      )}
      {ordering && user?.role === "customer" && price.data && (
        <OrderForm
          productId={product.id}
          optionIds={optionIds}
          prepay={price.data.prepay}
          remaining={price.data.remaining}
          hasInscription={price.data.lines.some((l) => l.group === "decor")}
          defaultName={user.displayName}
          onCancel={() => setOrdering(false)}
        />
      )}
      <Button variant="ghost" onClick={onBack}>
        Ко всем тортам
      </Button>
    </>
  );
}

// Форма без RecordForm: заказ создаёт placeOrder (цена, загрузка дня, номер), затем — предоплата через ЮKassa.
function OrderForm(props: {
  productId: Id<"product">;
  optionIds: Id<"product_option">[];
  prepay: number;
  remaining: number;
  hasInscription: boolean;
  defaultName: string;
  onCancel: () => void;
}) {
  const slots = useQuery("freeSlots", {});
  const [place, placing] = useMutation("placeOrder");
  const payment = usePayment("yookassa");
  const [form, setForm] = useState({
    slotId: "",
    fulfillment: "pickup",
    customerName: props.defaultName,
    customerPhone: "",
    customerEmail: "",
    address: "",
    inscription: "",
    note: "",
    consent: false,
  });
  const set = (k: keyof typeof form) => (v: unknown) => setForm({ ...form, [k]: v });
  const delivery = form.fulfillment === "delivery";
  const open = (slots.data ?? []).filter((s) => s.free > 0);

  const submit = async () => {
    const res = await place(
      {
        productId: props.productId,
        optionIds: props.optionIds,
        slotId: form.slotId as Id<"production_slot">,
        fulfillment: delivery ? "delivery" : "pickup",
        customerName: form.customerName,
        customerPhone: form.customerPhone,
        customerEmail: form.customerEmail || undefined,
        address: delivery ? form.address : undefined,
        inscription: form.inscription || undefined,
        note: form.note || undefined,
      },
      { consent: true },
    );
    await payment.pay("prepay", res.orderId);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (form.consent) void submit();
      }}
    >
      <Field
        name="slotId"
        label="Дата готовности"
        type="enum"
        required
        value={form.slotId}
        onChange={set("slotId")}
        enumOptions={open.map((s) => ({ value: s.id, label: `${dayLabel(s.date)} · свободно ${s.free}` }))}
        hint={slots.data && open.length === 0 ? "Свободных дней нет — загляните позже" : undefined}
      />
      <Field
        name="fulfillment"
        label="Получение"
        type="enum"
        required
        value={form.fulfillment}
        onChange={set("fulfillment")}
        enumOptions={[
          { value: "pickup", label: "Самовывоз" },
          { value: "delivery", label: "Доставка" },
        ]}
      />
      {delivery && (
        <Field name="address" label="Адрес доставки" type="string" required maxLength={300} value={form.address} onChange={set("address")} />
      )}
      {props.hasInscription && (
        <Field name="inscription" label="Надпись на торте" type="string" maxLength={60} value={form.inscription} onChange={set("inscription")} />
      )}
      <Field name="customerName" label="Имя" type="string" required maxLength={120} value={form.customerName} onChange={set("customerName")} />
      <Field name="customerPhone" label="Телефон" type="phone" required value={form.customerPhone} onChange={set("customerPhone")} />
      <Field
        name="customerEmail"
        label="Email для чека"
        type="email"
        hint="Чек придёт на почту; без неё — по SMS на телефон"
        value={form.customerEmail}
        onChange={set("customerEmail")}
      />
      <Field name="note" label="Комментарий" type="text" maxLength={1000} value={form.note} onChange={set("note")} />
      <Badge tone="accent">{`Сейчас — предоплата ${rub(props.prepay)}, при получении — ${rub(props.remaining)}`}</Badge>
      <ConsentCheckbox checked={form.consent} onChange={set("consent")} />
      {placing.error && <Badge tone="bad">{placing.error.details.message ?? "Не удалось оформить заказ"}</Badge>}
      {payment.error && <Badge tone="bad">{payment.error.details.message ?? "Не удалось перейти к оплате"}</Badge>}
      <Button
        type="submit"
        variant="primary"
        loading={placing.pending || payment.pending}
        disabled={!form.consent || !form.slotId}
      >
        Оплатить предоплату
      </Button>
      <Button variant="ghost" onClick={props.onCancel}>
        Отмена
      </Button>
    </form>
  );
}
