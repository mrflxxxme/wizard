import { useState } from "react";
import { Catalog, type Rec, useDataSource } from "../../src/index.js";
import type { Story } from "../story.js";

function TicketCatalog() {
  const avail = useDataSource().useFn<{ id: string; left: number }[]>("ticketAvailability", {});
  const left = new Map(avail.data?.map((t) => [t.id, t.left]));
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      <Catalog
        entity="ticket_type"
        query={{ filter: { active: true }, sort: { field: "price", dir: "asc" } }}
        map={(t: Rec) => ({
          id: t.id,
          title: String(t.name),
          description: t.description ? String(t.description) : undefined,
          price: t.kind === "partner" ? null : Number(t.price),
          priceText: "по промокоду",
          remaining: left.get(t.id) ?? null,
        })}
        onSelect={(t: Rec) => setPicked(String(t.name))}
      />
      {picked && <p role="status">{`Выбран билет «${picked}»`}</p>}
    </>
  );
}

export default {
  component: "Catalog",
  spec: "forum",
  role: null,
  render: () => <TicketCatalog />,
} satisfies Story;
