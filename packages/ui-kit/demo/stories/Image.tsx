import { Image } from "../../src/index.js";
import { DEMO_IMAGES } from "../fixtures.js";
import type { Story } from "../story.js";

export default {
  component: "Image",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Image" style={{ display: "grid", gap: "16px", maxWidth: "640px" }}>
      <Image testId="field" fileId={DEMO_IMAGES.one} alt="Пример фото из поля image" ratio="4/3" />
      <Image testId="square" fileId={DEMO_IMAGES.two} alt="Пример квадратного фото" ratio="1/1" />
      <Image testId="empty" fileId={null} alt="Фото ещё не загружено" />
    </div>
  ),
} satisfies Story;
