import { type ClientDoc, useState } from "@wizard/sdk";
import { Button, CabinetLayout, DataTable, RecordCard } from "@wizard/ui-kit";

type Application = ClientDoc<"speaker_application">;
type Status = Application["status"];

const SECTIONS: { id: Status; label: string }[] = [
  { id: "new", label: "Новые" },
  { id: "approved", label: "Одобренные" },
  { id: "rejected", label: "Отклонённые" },
];

// Телефон спикера скрыт от модератора правами (hiddenFields) — ни колонки, ни поля в карточке.
// Решение модератора — патч статуса; письмо и Telegram отправляет воркфлоу speaker_approved.
export default function Moderation() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const table = (status: Status) => (
    <DataTable
      entity="speaker_application"
      columns={["topic", "company", "stream", "created_at"]}
      query={{ filter: { status } }}
      defaultSort={{ field: "created_at", dir: "desc" }}
      filters={["stream"]}
      searchable
      onRowClick={(row: Application) => setSelectedId(row.id)}
      emptyText="Заявок нет"
    />
  );

  return (
    <CabinetLayout
      title="Модерация заявок"
      sections={SECTIONS.map((s) => ({ id: s.id, label: s.label, content: table(s.id) }))}
      defaultSection="new"
    >
      {selectedId && (
        <RecordCard
          entity="speaker_application"
          id={selectedId}
          fields={["full_name", "company", "topic", "abstract", "stream", "status", "moderator_comment"]}
          title={(r: Application) => r.topic}
          actions={[
            { id: "approve", label: "Одобрить", tone: "primary", kind: "update", patch: { status: "approved" }, visible: (r: Application) => r.status === "new" },
            { id: "reject", label: "Отклонить", tone: "danger", kind: "update", patch: { status: "rejected" }, confirm: "Отклонить заявку?", visible: (r: Application) => r.status === "new" },
          ]}
        />
      )}
      {selectedId && <Button variant="ghost" onClick={() => setSelectedId(null)}>Закрыть</Button>}
    </CabinetLayout>
  );
}
