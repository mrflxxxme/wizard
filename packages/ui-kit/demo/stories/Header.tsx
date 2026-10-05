import { Header } from "../../src/index.js";
import { DEMO_IMAGES } from "../fixtures.js";
import type { Story } from "../story.js";

const links = [
  { label: "Услуги", href: "#services" },
  { label: "Как записаться", href: "#steps" },
  { label: "Вопросы", href: "#faq" },
];

export default {
  component: "Header",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Header">
      <Header
        testId="bar"
        brand="Пример: студия"
        links={links}
        cta={{ label: "Записаться", href: "#lead" }}
      />
      <Header
        testId="centered"
        variant="centered"
        brand="Пример: студия"
        logo={{ fileId: DEMO_IMAGES.hero, alt: "Логотип (пример)" }}
        links={links}
      />
    </div>
  ),
} satisfies Story;
