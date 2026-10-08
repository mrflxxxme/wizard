// useCatalog and useContent (V3-10, C4): the showcase of the catalog module and any public content list of a v3 page
// without markup — what the role may read (the server applies rowFilter and hiddenFields), «Показать ещё», the section
// filter of the catalog. The categories themselves are a list too: useContent(categoryEntity).
import { useState } from "react";
import type { ListQuery, Rec } from "../../data/types.js";
import { LIST_PAGE, type PagedList, usePagedList } from "./list.js";

/** Names of the catalog module contract (@wizard/modules CATALOG_NAMES) the showcase reads by default. */
export const CATALOG_DEFAULTS = {
  entity: "service",
  active: "active",
  sortOrder: "sort_order",
  categoryField: "category",
  categoryEntity: "service_category",
} as const;

export interface UseCatalogOptions {
  /** Visible items (default: {active: true} — the owner hid nothing). */
  filter?: Readonly<Record<string, unknown>>;
  /** Order (default: the owner's order, sort_order ascending). */
  sort?: ListQuery["sort"];
  /** Field of the section the filter of setCategory applies to (default: category). */
  categoryField?: string;
  /** Rows per «Показать ещё» (default 24). */
  pageSize?: number;
  search?: string;
}

export interface CatalogModel<T = Rec> extends PagedList<T> {
  /** The chosen section id (null — all). */
  category: string | null;
  setCategory(id: string | null): void;
}

/** The catalog showcase over the DataSource: visible items in the owner's order, by section. */
export function useCatalog<T = Rec>(
  entity: string = CATALOG_DEFAULTS.entity,
  o: UseCatalogOptions = {},
): CatalogModel<T> {
  const [category, setCategory] = useState<string | null>(null);
  const field = o.categoryField ?? CATALOG_DEFAULTS.categoryField;
  const filter = {
    ...(o.filter ?? { [CATALOG_DEFAULTS.active]: true }),
    ...(category ? { [field]: category } : {}),
  };
  const list = usePagedList<T>(
    entity,
    {
      filter,
      sort: o.sort ?? { field: CATALOG_DEFAULTS.sortOrder, dir: "asc" },
      ...(o.search ? { search: o.search } : {}),
    },
    { page: o.pageSize ?? LIST_PAGE },
  );
  return { ...list, category, setCategory };
}

export interface UseContentOptions {
  filter?: Readonly<Record<string, unknown>>;
  sort?: ListQuery["sort"];
  /** Rows per «Показать ещё» (default 24). */
  pageSize?: number;
  search?: string;
}

/** A public list of `entity` (site photos, materials, a client's own records): read permission and paging. */
export function useContent<T = Rec>(entity: string, o: UseContentOptions = {}): PagedList<T> {
  return usePagedList<T>(
    entity,
    {
      ...(o.filter ? { filter: { ...o.filter } } : {}),
      ...(o.sort ? { sort: o.sort } : {}),
      ...(o.search ? { search: o.search } : {}),
    },
    { page: o.pageSize ?? LIST_PAGE },
  );
}
