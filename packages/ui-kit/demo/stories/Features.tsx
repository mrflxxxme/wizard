import { Features } from "../../src/index.js";
import { DEMO_IMAGES } from "../fixtures.js";
import type { Story } from "../story.js";

const points = [
  { title: "Пример преимущества", text: "Короткое пояснение из брифа владельца. Здесь — текст-пример." },
  { title: "Ещё пример", text: "Только факты, которые назвал владелец: адрес, опыт, гарантии." },
  { title: "Третий пример", text: "Если фактов нет — пунктов меньше, а не выдуманные." },
];
const cards = [
  {
    title: "Пример: базовая услуга",
    text: "Описание услуги (пример).",
    image: { fileId: DEMO_IMAGES.one, alt: "Пример фото услуги" },
  },
  {
    title: "Пример: расширенная услуга",
    text: "Описание услуги (пример).",
    image: { fileId: DEMO_IMAGES.two, alt: "Пример фото услуги" },
  },
  { title: "Пример: услуга без фото", text: "Карточка без картинки тоже аккуратна." },
];

export default {
  component: "Features",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Features">
      <Features testId="grid" title="Пример: почему мы" intro="Пример вступления к списку." items={points} />
      <Features
        testId="cards"
        anchor="services"
        variant="cards"
        tone="alt"
        title="Пример: услуги"
        items={cards}
      />
      <Features
        testId="alternating"
        variant="alternating"
        title="Пример: как мы работаем"
        items={cards.slice(0, 2)}
      />
    </div>
  ),
} satisfies Story;
