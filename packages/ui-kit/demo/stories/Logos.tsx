import { Logos } from "../../src/index.js";
import type { Story } from "../story.js";

const items = [
  { name: "Пример: Альфа" },
  { name: "Пример: Бета" },
  { name: "Пример: Гамма" },
  { name: "Пример: Дельта" },
  { name: "Пример: Омега" },
];

export default {
  component: "Logos",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Logos">
      <Logos testId="row" title="Пример: нам доверяют" items={items} />
      <Logos testId="grid" variant="grid" tone="alt" title="Пример: партнёры" items={items} />
      <Logos testId="marquee" variant="marquee" items={items} />
    </div>
  ),
} satisfies Story;
