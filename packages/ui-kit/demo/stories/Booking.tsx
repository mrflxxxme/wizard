import { Booking } from "../../src/index.js";
import type { Story } from "../story.js";

const action = { label: "Выбрать время", href: "/booking" };

export default {
  component: "Booking",
  spec: "studio",
  role: null,
  render: () => (
    <div data-variants="Booking">
      <Booking
        testId="card"
        title="Пример: запишитесь онлайн"
        intro="Пример: свободное время видно сразу."
        action={action}
      />
      <Booking testId="split" variant="split" title="Пример: запись за минуту" action={action} />
      <Booking testId="inline" variant="inline" title="Пример: запись в одну строку" action={action} />
    </div>
  ),
} satisfies Story;
