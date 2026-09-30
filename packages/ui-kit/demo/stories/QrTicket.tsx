import { QrTicket } from "../../src/index.js";
import type { Story } from "../story.js";

export default {
  component: "QrTicket",
  spec: "forum",
  role: "participant",
  render: () => (
    <QrTicket
      entity="ticket"
      id="ticket_001"
      tokenField="qr_token"
      title="Форум «Северный ритейл»"
      subtitle="14 ноября · 09:30 · Казань"
      meta={[
        { label: "Билет", value: "Стандарт" },
        { label: "Поток", value: "Логистика" },
      ]}
      hint="Покажите QR на входе А"
    />
  ),
} satisfies Story;
