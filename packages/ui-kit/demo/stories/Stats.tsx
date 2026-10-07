import { Stats } from "../../src/index.js";
import type { Story } from "../story.js";

const items = [
  { value: "12 лет", label: "Пример: работаем с 2014 года" },
  { value: "3 000+", label: "Пример: клиентов из брифа" },
  { value: "4,9", label: "Пример: рейтинг на картах" },
];

export default {
  component: "Stats",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Stats">
      <Stats testId="row" title="Пример: в цифрах" items={items} />
      <Stats testId="cards" variant="cards" tone="alt" items={items} />
      <Stats testId="band" variant="band" items={items} />
    </div>
  ),
} satisfies Story;
