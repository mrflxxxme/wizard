import { type ClientDoc, useState } from "@wizard/sdk";
import { Button, CabinetLayout, DataTable, RecordForm } from "@wizard/ui-kit";

type Product = ClientDoc<"product">;
type Option = ClientDoc<"product_option">;
type Slot = ClientDoc<"production_slot">;

// Кабинет владельца: справочники через data API (права owner — полные). Фото (file) до M2 не редактируется:
// RecordForm поле file не рендерит (G0-SPEC-06), поэтому в fields его нет.
export default function CatalogAdmin() {
  return (
    <CabinetLayout
      title="Изделия и опции"
      defaultSection="products"
      sections={[
        { id: "products", label: "Изделия", content: <Products /> },
        { id: "options", label: "Опции и цены", content: <Options /> },
        { id: "slots", label: "Производственные дни", content: <Slots /> },
      ]}
    />
  );
}

/** Таблица + форма: клик по строке — редактирование, кнопка — новая запись. */
function useEditor() {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return {
    editing,
    open: (id: string | "new") => setEditing(id),
    close: () => setEditing(null),
  };
}

function Products() {
  const ed = useEditor();
  return (
    <>
      <DataTable
        entity="product"
        columns={["name", "active", "created_at"]}
        defaultSort={{ field: "name", dir: "asc" }}
        searchable
        onRowClick={(p: Product) => ed.open(p.id)}
        emptyText="Изделий пока нет"
      />
      {ed.editing ? (
        <RecordForm
          key={ed.editing}
          entity="product"
          mode={ed.editing === "new" ? "create" : "edit"}
          id={ed.editing === "new" ? undefined : ed.editing}
          fields={["name", "description", "active"]}
          onSuccess={ed.close}
          onCancel={ed.close}
        />
      ) : (
        <Button variant="secondary" onClick={() => ed.open("new")}>
          Добавить изделие
        </Button>
      )}
    </>
  );
}

// Цена опции веса — базовая цена торта, остальные группы — надбавки (functions/lib/pricing.ts).
function Options() {
  const ed = useEditor();
  return (
    <>
      <DataTable
        entity="product_option"
        columns={["product", "option_group", "title", "price", "weight_kg", "sort_order", "active"]}
        defaultSort={{ field: "sort_order", dir: "asc" }}
        filters={["product", "option_group", "active"]}
        onRowClick={(o: Option) => ed.open(o.id)}
        emptyText="Опций пока нет"
      />
      {ed.editing ? (
        <RecordForm
          key={ed.editing}
          entity="product_option"
          mode={ed.editing === "new" ? "create" : "edit"}
          id={ed.editing === "new" ? undefined : ed.editing}
          fields={["product", "option_group", "title", "price", "weight_kg", "sort_order", "active"]}
          onSuccess={ed.close}
          onCancel={ed.close}
        />
      ) : (
        <Button variant="secondary" onClick={() => ed.open("new")}>
          Добавить опцию
        </Button>
      )}
    </>
  );
}

function Slots() {
  const ed = useEditor();
  return (
    <>
      <DataTable
        entity="production_slot"
        columns={["slot_date", "capacity", "closed"]}
        defaultSort={{ field: "slot_date", dir: "asc" }}
        onRowClick={(s: Slot) => ed.open(s.id)}
        emptyText="Откройте производственные дни, чтобы покупатели могли выбрать дату"
      />
      {ed.editing ? (
        <RecordForm
          key={ed.editing}
          entity="production_slot"
          mode={ed.editing === "new" ? "create" : "edit"}
          id={ed.editing === "new" ? undefined : ed.editing}
          fields={["slot_date", "capacity", "closed"]}
          defaults={{ capacity: 5 }}
          onSuccess={ed.close}
          onCancel={ed.close}
        />
      ) : (
        <Button variant="secondary" onClick={() => ed.open("new")}>
          Добавить день
        </Button>
      )}
    </>
  );
}
