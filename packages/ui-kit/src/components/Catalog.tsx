// Catalog (ui-kit.yaml#components.Catalog): ItemCard grid over DataSource.useList, «Показать ещё» by 24 — the paged
// list of the v3 headless hooks (usePagedList, V3-10).
import { type ReactNode, useState } from "react";
import { cx, useWzRoot } from "../data/context.js";
import type { Rec } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { LIST_MAX, LIST_PAGE, usePagedList } from "../v3/headless/list.js";
import { ButtonImpl } from "./Button.js";
import styles from "./Catalog.module.css";
import { ItemCardImpl } from "./ItemCard.js";
import { part } from "./root.js";
import { DataState } from "./States.js";
import type { CatalogProps, Selection } from "./types.js";

const PAGE = LIST_PAGE;
const MAX = LIST_MAX; // data API limit ≤ 100 per request

export function Catalog<T = Rec>(props: CatalogProps<T>): ReactNode {
  const root = useWzRoot("Catalog", "wz-catalog", props);
  const paged = usePagedList<T>(props.entity, props.query, { page: PAGE, max: MAX });
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const { list, pageSize } = paged;
  const cols = props.columns ?? "auto";

  let body: ReactNode = (
    <DataState result={list} empty={list.data?.items.length === 0} emptyText={props.emptyText} />
  );
  if (list.data && list.data.items.length > 0 && !list.error) {
    const cards = list.data.items.map((item) => ({ item, data: props.map(item) }));
    // Sold-out cards stay in the grid, at the end (stable order otherwise).
    cards.sort((a, b) => Number(a.data.remaining === 0) - Number(b.data.remaining === 0));
    body = (
      <>
        <div className={cx(styles.grid, styles[`cols${cols}`])}>
          {cards.map(({ item, data }) => (
            <ItemCardImpl
              key={data.id}
              root={part("wz-itemcard")}
              {...data}
              optionGroups={props.optionGroups}
              selection={selections[data.id] ?? {}}
              onSelectionChange={(s) => setSelections((all) => ({ ...all, [data.id]: s }))}
              onCta={() => props.onSelect(item, selections[data.id] ?? {})}
            />
          ))}
        </div>
        {list.data.total > list.data.items.length && pageSize < MAX && (
          <ButtonImpl root={part("wz-catalog-more")} onClick={paged.more} loading={list.isLoading}>
            {ru.catalog.more}
          </ButtonImpl>
        )}
      </>
    );
  }
  return (
    <section
      {...root}
      className={cx(styles.catalog, props.className)}
      aria-busy={list.isLoading || undefined}
    >
      {body}
    </section>
  );
}
