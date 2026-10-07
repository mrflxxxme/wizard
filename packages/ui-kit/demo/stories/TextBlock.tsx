import { TextBlock } from "../../src/index.js";
import type { Story } from "../story.js";

const text =
  "Пример текста владельца: о подходе, правилах или условиях.\n\nПример второго абзаца: подробности, которые важно прочитать до визита.\n\nПример третьего абзаца для двух колонок.";

export default {
  component: "TextBlock",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="TextBlock">
      <TextBlock testId="plain" title="Пример: как мы работаем" text={text} />
      <TextBlock testId="two_columns" variant="two_columns" tone="alt" title="Пример: условия" text={text} />
      <TextBlock testId="quote" variant="quote" text="Пример: главная мысль владельца одной фразой." />
    </div>
  ),
} satisfies Story;
