import { Cta } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "Cta",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Cta">
      <Cta
        testId="band"
        title="Пример призыва к действию"
        text="Пример пояснения под призывом."
        action={{ label: "Записаться", href: "#lead" }}
        secondary={{ label: "Позвонить", href: "tel:+70000000000" }}
      />
      <Cta
        testId="card"
        variant="card"
        title="Пример: карточка призыва"
        action={{ label: "Оставить заявку", href: "#lead" }}
      />
    </div>
  ),
} satisfies Story;
