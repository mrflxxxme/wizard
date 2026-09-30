import { StatsReport } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "StatsReport",
  spec: "forum",
  role: "organizer",
  render: () => <StatsReport title="Сводка" subtitle="до форума 45 дней" fn="forumStats" />,
} satisfies Story;
