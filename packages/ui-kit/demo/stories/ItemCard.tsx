import { useState } from "react";
import { ItemCard, type OptionGroup, type Selection } from "../../src/index.js";
import type { Story } from "../story.js";
import styles from "./stories.module.css";

const GROUPS: OptionGroup[] = [
  {
    id: "weight",
    label: "Вес",
    kind: "single",
    required: true,
    choices: [
      { id: "w15", label: "1,5 кг" },
      { id: "w2", label: "2 кг", priceDelta: 900 },
    ],
  },
  {
    id: "decor",
    label: "Декор",
    kind: "multi",
    choices: [
      { id: "berries", label: "Ягоды", priceDelta: 500 },
      { id: "gold", label: "Золото", priceDelta: 600 },
    ],
  },
];

function Cards() {
  const [sel, setSel] = useState<Selection>({ weight: ["w15"] });
  const [done, setDone] = useState("");
  return (
    <div className={styles.grid}>
      <ItemCard
        testId="cake"
        id="cake"
        title="Медовик"
        description="Классический медовый торт"
        price={4900}
        optionGroups={GROUPS}
        selection={sel}
        onSelectionChange={setSel}
        onCta={() => setDone("Медовик")}
        ctaLabel="В корзину"
      />
      <ItemCard
        testId="low"
        id="low"
        title="Стандарт"
        price={9900}
        remaining={18}
        onCta={() => setDone("Стандарт")}
      />
      <ItemCard testId="one" id="one" title="VIP" price={24900} remaining={1} onCta={() => setDone("VIP")} />
      <ItemCard
        testId="none"
        id="none"
        title="Мастер-класс"
        price={3500}
        remaining={0}
        onCta={() => setDone("—")}
      />
      {done && <p role="status">{`Выбрано: ${done}`}</p>}
    </div>
  );
}

export default { component: "ItemCard", spec: "bakery", role: null, render: () => <Cards /> } satisfies Story;
