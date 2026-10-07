import { Pricing } from "../../src/index.js";
import type { Story } from "../story.js";

const common = {
  entity: "service",
  nameField: "title",
  descriptionField: "description",
  details: [{ field: "duration_min", suffix: "мин" }],
  action: { label: "Записаться", href: "#lead" },
};

export default {
  component: "Pricing",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Pricing">
      <Pricing testId="cards" title="Пример: цены" intro="Цены из кабинета владельца." {...common} />
      <Pricing
        testId="table"
        variant="table"
        tone="alt"
        title="Пример: прайс-лист"
        note="Пример примечания: цены из брифа."
        {...common}
      />
      <Pricing testId="compact" variant="compact" title="Пример: коротко о ценах" {...common} />
    </div>
  ),
} satisfies Story;
