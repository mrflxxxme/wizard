import { About } from "../../src/index.js";
import { DEMO_IMAGES } from "../fixtures.js";
import type { Story } from "../story.js";

const text =
  "Пример: кто мы и чем занимаемся — словами владельца из брифа.\n\nПример второго абзаца: как всё начиналось, что для нас важно и почему к нам возвращаются.";

export default {
  component: "About",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="About">
      <About
        testId="split"
        title="Пример: о студии"
        text={text}
        image={{ fileId: DEMO_IMAGES.two, alt: "Пример фото студии" }}
      />
      <About testId="centered" variant="centered" tone="alt" title="Пример: о нас по центру" text={text} />
      <About testId="story" variant="story" title="Пример: наша история" text={text} />
      <About testId="graphic" title="Пример: без фото — графика темы" text={text} />
    </div>
  ),
} satisfies Story;
