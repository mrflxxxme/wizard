import { GoalHints } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "GoalHints",
  spec: "forum",
  role: "organizer",
  render: () => (
    <div data-variants="GoalHints">
      <GoalHints
        subtitle="Пример: по показателям за 30 дней"
        items={[
          {
            id: "booking_reminder_cancel",
            title: "Много отмен записи",
            text: "Пример: отменяется 23 % записей. Включите письмо-напоминание посетителю за сутки до визита.",
            action: { label: "Изменить в Born to Build", href: "https://borntobuild.ru/", external: true },
          },
          {
            id: "leads_owner",
            title: "Заявки остаются без ответа",
            text: "Пример: в работу взято 40 % заявок. Назначьте ответственного за новые заявки.",
            action: { label: "Открыть заявки", href: "#lead" },
          },
        ]}
      />
      <GoalHints testId="empty" items={[]} emptyText="Пример: подсказки появятся, когда наберутся данные" />
    </div>
  ),
} satisfies Story;
