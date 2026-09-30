import { type Rec, RecordCard } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "RecordCard",
  spec: "forum",
  role: "moderator",
  render: () => (
    <RecordCard
      entity="speaker_application"
      id="app_003"
      fields={["full_name", "company", "topic", "abstract", "stream", "status", "phone"]}
      title={(r: Rec) => String(r.topic)}
      actions={[
        {
          id: "approve",
          label: "Одобрить",
          tone: "primary",
          kind: "update",
          patch: { status: "approved" },
          visible: (r: Rec) => r.status === "new",
        },
        {
          id: "reject",
          label: "Отклонить",
          tone: "danger",
          kind: "update",
          patch: { status: "rejected" },
          confirm: "Отклонить заявку?",
          visible: (r: Rec) => r.status === "new",
        },
      ]}
    />
  ),
} satisfies Story;
