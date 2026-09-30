import { DataTable } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "DataTable",
  spec: "forum",
  role: "organizer",
  render: () => (
    <DataTable
      entity="speaker_application"
      columns={["topic", "full_name", "phone", "stream", "status", "created_at"]}
      filters={["status", "stream"]}
      searchable
      defaultSort={{ field: "created_at", dir: "desc" }}
      pageSize={25}
      emptyText="Заявок нет"
    />
  ),
} satisfies Story;
