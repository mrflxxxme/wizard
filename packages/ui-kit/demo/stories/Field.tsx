import { useState } from "react";
import { Field } from "../../src/index.js";
import type { Story } from "../story.js";
import styles from "./stories.module.css";

const STREAMS = ["Ритейл", "Логистика", "Маркетинг", "Финансы", "HR", "ИТ"].map((label, i) => ({
  value: `s${i + 1}`,
  label,
}));
const KINDS = [
  { value: "standard", label: "Стандарт" },
  { value: "vip", label: "VIP" },
];

function Fields() {
  const [v, setV] = useState<Record<string, unknown>>({
    email: "ivan@",
    kind: "vip",
    stream: "s4",
    agree: false,
  });
  const set = (k: string) => (x: unknown) => setV((o) => ({ ...o, [k]: x }));
  return (
    <div className={styles.form}>
      <Field
        name="name"
        label="ФИО"
        type="string"
        required
        value={v.name}
        onChange={set("name")}
        maxLength={80}
      />
      <Field
        name="email"
        label="Email"
        type="email"
        required
        value={v.email}
        onChange={set("email")}
        error="Введите email, например name@example.ru"
      />
      <Field
        name="phone"
        label="Телефон"
        type="phone"
        value={v.phone}
        onChange={set("phone")}
        hint="Для связи"
      />
      <Field name="price" label="Цена" type="money" value={v.price} onChange={set("price")} min={0} />
      <Field
        name="kind"
        label="Тип билета"
        type="enum"
        value={v.kind}
        onChange={set("kind")}
        enumOptions={KINDS}
      />
      <Field
        name="stream"
        label="Поток"
        type="enum"
        value={v.stream}
        onChange={set("stream")}
        enumOptions={STREAMS}
      />
      <Field name="agree" label="Нужна парковка" type="bool" value={v.agree} onChange={set("agree")} />
      <Field name="date" label="Дата" type="date" value={v.date} onChange={set("date")} />
      <Field name="about" label="О себе" type="text" value={v.about} onChange={set("about")} />
      <Field name="number" label="Номер заказа" type="int" value={101} onChange={set("number")} readOnly />
    </div>
  );
}

export default { component: "Field", spec: "forum", role: null, render: () => <Fields /> } satisfies Story;
