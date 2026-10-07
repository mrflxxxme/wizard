import { Testimonials } from "../../src/index.js";
import type { Story } from "../story.js";

const items = [
  {
    text: "Пример отзыва: короткий и живой текст клиента из брифа владельца.",
    author: "Пример: Мария",
    source: "Яндекс Карты",
  },
  {
    text: "Пример отзыва подлиннее: что понравилось, как прошёл визит, что запомнилось.",
    author: "Пример: Олег",
  },
  { text: "Пример: третий отзыв без подписи источника.", author: "Пример: Анна" },
  { text: "Пример: четвёртый отзыв для карусели.", source: "2ГИС" },
];

export default {
  component: "Testimonials",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Testimonials">
      <Testimonials testId="cards" title="Пример: отзывы" items={items.slice(0, 3)} />
      <Testimonials testId="quote" variant="quote" tone="alt" items={items} />
      <Testimonials testId="carousel" variant="carousel" title="Пример: что говорят клиенты" items={items} />
      <Testimonials
        testId="accent"
        variant="cards"
        tone="accent"
        title="Пример: отзывы на цвете"
        items={items.slice(0, 3)}
      />
    </div>
  ),
} satisfies Story;
