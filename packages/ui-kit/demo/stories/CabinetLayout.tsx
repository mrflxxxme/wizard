import { CabinetLayout, DataTable } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "CabinetLayout",
  spec: "forum",
  role: "participant",
  render: () => (
    <CabinetLayout
      sections={[
        {
          id: "tickets",
          label: "Мои билеты",
          content: (
            <DataTable
              testId="my-tickets"
              entity="ticket"
              columns={["ticket_type", "stream", "status", "amount"]}
            />
          ),
        },
        { id: "profile", label: "Профиль", content: <p>Имя, почта и телефон для связи.</p> },
      ]}
    />
  ),
} satisfies Story;
