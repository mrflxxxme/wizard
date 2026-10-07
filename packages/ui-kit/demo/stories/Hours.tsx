import { Hours } from "../../src/index.js";
import type { Story } from "../story.js";

const items = [
  { day: "Пн–Пт", time: "10:00–21:00" },
  { day: "Суббота", time: "11:00–19:00" },
  { day: "Воскресенье", time: "выходной" },
];

export default {
  component: "Hours",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Hours">
      <Hours testId="table" items={items} />
      <Hours testId="cards" variant="cards" tone="alt" title="Пример: когда мы открыты" items={items} />
      <Hours testId="inline" variant="inline" title="Пример: часы в строку" items={items} />
    </div>
  ),
} satisfies Story;
