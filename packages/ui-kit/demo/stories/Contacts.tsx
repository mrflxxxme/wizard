import { Contacts } from "../../src/index.js";
import type { Story } from "../story.js";

const contacts = {
  address: "Пример: г. Город, ул. Примерная, 1",
  phone: "+7 000 000-00-00",
  email: "studio@example.ru",
  hours: "Пример: ежедневно 10:00–21:00",
  messengers: ["Telegram: t.me/example", "Пример: ВКонтакте"],
};

export default {
  component: "Contacts",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Contacts">
      <Contacts testId="card" title="Пример: контакты" {...contacts} />
      <Contacts testId="split" variant="split" tone="alt" title="Пример: как нас найти" {...contacts} />
      <Contacts testId="columns" variant="columns" title="Пример: контакты в колонках" {...contacts} />
    </div>
  ),
} satisfies Story;
