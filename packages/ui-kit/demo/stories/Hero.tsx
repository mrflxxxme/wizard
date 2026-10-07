import { Hero } from "../../src/index.js";
import { DEMO_IMAGES } from "../fixtures.js";
import type { Story } from "../story.js";

const common = {
  eyebrow: "Пример · город",
  subtitle: "Пример подзаголовка: что вы делаете и чем это полезно клиенту. Замените своим текстом.",
  primary: { label: "Записаться", href: "#lead" },
  secondary: { label: "Услуги", href: "#services" },
};

export default {
  component: "Hero",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Hero">
      <Hero
        testId="split"
        title="Пример заголовка первого экрана"
        {...common}
        image={{ fileId: DEMO_IMAGES.hero, alt: "Пример фотографии студии" }}
      />
      <Hero
        testId="centered"
        variant="centered"
        tone="accent"
        title="Пример: заголовок на фирменном цвете"
        {...common}
      />
      <Hero
        testId="cover"
        variant="cover"
        title="Пример: заголовок поверх фотографии"
        {...common}
        image={{ fileId: DEMO_IMAGES.three, alt: "Пример фотографии работы" }}
      />
      <Hero testId="minimal" variant="minimal" title="Пример: заголовок-плакат без фото" {...common} />
      <Hero
        testId="collage"
        variant="collage"
        title="Пример: коллаж из фотографий"
        {...common}
        image={{ fileId: DEMO_IMAGES.one, alt: "Пример фото работы" }}
        images={[
          { fileId: DEMO_IMAGES.two, alt: "Пример фото работы" },
          { fileId: DEMO_IMAGES.three, alt: "Пример фото интерьера" },
        ]}
      />
      <Hero testId="graphic" variant="collage" title="Пример: без фото — графика темы" {...common} />
    </div>
  ),
} satisfies Story;
