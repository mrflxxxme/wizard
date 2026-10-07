import { Faq } from "../../src/index.js";
import type { Story } from "../story.js";

const items = [
  { question: "Пример вопроса про цены?", answer: "Пример ответа: цены назовёт владелец в брифе." },
  { question: "Пример вопроса про запись?", answer: "Пример ответа: запись через форму на этой странице." },
  { question: "Пример вопроса про оплату?", answer: "Пример ответа: способ оплаты из брифа." },
];

export default {
  component: "Faq",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Faq">
      <Faq testId="accordion" anchor="faq" title="Пример: частые вопросы" items={items} />
      <Faq
        testId="columns"
        variant="columns"
        tone="alt"
        title="Пример: вопросы в две колонки"
        items={items}
      />
      <Faq
        testId="split"
        variant="split"
        title="Пример: вопросы слева"
        intro="Пример: не нашли ответ — напишите нам."
        items={items}
      />
    </div>
  ),
} satisfies Story;
