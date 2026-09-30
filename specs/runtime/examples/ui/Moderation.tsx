import { useEntityList, useEntityMutation, useState } from "@wizard/sdk";
import { Button, CabinetLayout, DataTable, RecordCard } from "@wizard/ui-kit";

type Status = "new" | "approved" | "rejected";
const TABS: { value: Status; label: string }[] = [
  { value: "new", label: "Новые" },
  { value: "approved", label: "Одобренные" },
  { value: "rejected", label: "Отклонённые" },
];

// Телефон спикера скрыт от модератора правами (hiddenFields), поэтому его нет в колонках.
export default function Moderation() {
  const [status, setStatus] = useState<Status>("new");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useEntityList("speaker_application", { filter: { status }, sort: "-created_at", limit: 50 });
  const { update } = useEntityMutation("speaker_application");
  const selected = list.items.find((a) => a.id === selectedId);

  const decide = async (id: string, next: Status) => {
    await update(id, { status: next });
    setSelectedId(null);
  };

  return (
    <CabinetLayout title="Модерация заявок" tabs={TABS} activeTab={status} onTabChange={(t: Status) => setStatus(t)}>
      <DataTable
        entity="speaker_application"
        rows={list.items}
        columns={["topic", "company", "stream", "created_at"]}
        loading={list.isLoading}
        onRowClick={(row: { id: string }) => setSelectedId(row.id)}
      />
      {selected && (
        <RecordCard
          entity="speaker_application"
          record={selected}
          fields={["full_name", "company", "topic", "abstract", "stream", "moderator_comment"]}
          actions={
            selected.status === "new" && (
              <>
                <Button onClick={() => void decide(selected.id, "approved")}>Одобрить</Button>
                <Button variant="secondary" onClick={() => void decide(selected.id, "rejected")}>Отклонить</Button>
              </>
            )
          }
        />
      )}
    </CabinetLayout>
  );
}
