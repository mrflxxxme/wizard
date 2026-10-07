import { Footer } from "../../src/index.js";
import type { Story } from "../story.js";

const columns = [
  {
    title: "Разделы",
    links: [
      { label: "Услуги", href: "#services" },
      { label: "Вопросы", href: "#faq" },
    ],
  },
];
const contacts = [
  { label: "Телефон (пример)", value: "+7 000 000-00-00", href: "tel:+70000000000" },
  { label: "Почта (пример)", value: "studio@example.ru", href: "mailto:studio@example.ru" },
];

export default {
  component: "Footer",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Footer">
      <Footer
        testId="simple"
        brand="Пример: студия"
        columns={columns}
        legal="Пример: ИП Фамилия И. О., ИНН из брифа"
      />
      <Footer
        testId="columns"
        variant="columns"
        brand="Пример: студия"
        text="Пример короткого описания."
        columns={columns}
        contacts={contacts}
      />
      <Footer testId="minimal" variant="minimal" brand="Пример: студия" legal="Пример: ИП, ИНН из брифа" />
    </div>
  ),
} satisfies Story;
