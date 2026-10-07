import { Gallery } from "../../src/index.js";
import { DEMO_IMAGES } from "../fixtures.js";
import type { Story } from "../story.js";

const items = [
  { caption: "Пример: работа мастера", image: { fileId: DEMO_IMAGES.one, alt: "Пример фото работы" } },
  { caption: "Пример: интерьер", image: { fileId: DEMO_IMAGES.two, alt: "Пример фото интерьера" } },
  { caption: "Пример: без фото — графика темы" },
  { image: { fileId: DEMO_IMAGES.three, alt: "Пример фото детали" } },
  { caption: "Пример: ещё работа" },
  { caption: "Пример: зал", image: { fileId: DEMO_IMAGES.hero, alt: "Пример фото зала" } },
];

export default {
  component: "Gallery",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Gallery">
      <Gallery testId="grid" title="Пример: наши работы" items={items} />
      <Gallery
        testId="masonry"
        variant="masonry"
        tone="alt"
        title="Пример: галерея разной высоты"
        items={items}
      />
      <Gallery testId="carousel" variant="carousel" title="Пример: листайте" items={items} />
    </div>
  ),
} satisfies Story;
