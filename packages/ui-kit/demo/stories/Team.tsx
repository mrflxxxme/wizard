import { Team } from "../../src/index.js";
import { DEMO_IMAGES } from "../fixtures.js";
import type { Story } from "../story.js";

const items = [
  {
    name: "Пример: старший мастер",
    role: "Стрижки и укладки",
    text: "Пример: опыт и специализация со слов владельца.",
    image: { fileId: DEMO_IMAGES.one, alt: "Пример портрета" },
  },
  { name: "Пример: мастер", role: "Окрашивание", text: "Пример короткого описания." },
  { name: "Пример: администратор", role: "Запись и вопросы" },
];

export default {
  component: "Team",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Team">
      <Team testId="cards" title="Пример: команда" intro="Пример вступления." items={items} />
      <Team testId="row" variant="row" tone="alt" title="Пример: мастера в ряд" items={items} />
      <Team testId="list" variant="list" title="Пример: команда списком" items={items} />
    </div>
  ),
} satisfies Story;
