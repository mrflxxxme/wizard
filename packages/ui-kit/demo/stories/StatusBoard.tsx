import { type Rec, StatusBoard } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "StatusBoard",
  spec: "bakery",
  role: "staff",
  render: () => (
    <StatusBoard
      entity="cake_order"
      statusField="status"
      columns={["prepaid", "in_production", "ready"]}
      card={(r: Rec) => ({
        title: `Заказ №${r.number}`,
        subtitle: String(r.customer_name ?? ""),
        meta: String(r.inscription ?? ""),
      })}
    />
  ),
} satisfies Story;
