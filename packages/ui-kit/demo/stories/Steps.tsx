import { Steps } from "../../src/index.js";
import type { Story } from "../story.js";

const steps = [
  { title: "Пример: оставьте заявку", text: "Форма внизу страницы (пример текста)." },
  { title: "Пример: подтверждение", text: "Вам ответят по телефону или почте." },
  { title: "Пример: визит", text: "Приходите в выбранное время." },
];

export default {
  component: "Steps",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Steps">
      <Steps testId="numbered" anchor="steps" title="Пример: как записаться" steps={steps} />
      <Steps testId="timeline" variant="timeline" tone="alt" title="Пример: этапы работы" steps={steps} />
    </div>
  ),
} satisfies Story;
