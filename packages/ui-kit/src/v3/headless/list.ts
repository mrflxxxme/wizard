// Paged lists of the headless hooks (V3-10, C4) and of the Catalog component: «Показать ещё» by a page, at most 96
// rows (the data API gives ≤ 100 per request), the role's read permission.
import { useState } from "react";
import { useCan, useDataSource } from "../../data/context.js";
import type { AsyncResult, ListQuery, Rec, WzError } from "../../data/types.js";

/** Rows per «Показать ещё» of a catalog. */
export const LIST_PAGE = 24;
/** At most this many rows in a paged list (the data API limit is 100 per request). */
export const LIST_MAX = 96;

export interface PagedList<T = Rec> {
  /** The DataSource result as is (loading, error, refetch). */
  list: AsyncResult<{ items: T[]; total: number }>;
  items: T[];
  total: number;
  isLoading: boolean;
  error?: WzError;
  /** Rows requested now. */
  pageSize: number;
  /** More rows exist and the limit is not reached: show «Показать ещё». */
  hasMore: boolean;
  more(): void;
  /** The role may read the entity. */
  canRead: boolean;
}

/** A list of `entity` grown by `page` rows on more(), at most `max` rows. */
export function usePagedList<T = Rec>(
  entity: string,
  query: Omit<ListQuery, "page"> = {},
  o: { page?: number; max?: number } = {},
): PagedList<T> {
  const ds = useDataSource();
  const can = useCan();
  const [pages, setPages] = useState(1);
  const max = Math.min(o.max ?? LIST_MAX, 100);
  const pageSize = Math.min((o.page ?? LIST_PAGE) * pages, max);
  const list = ds.useList<T>(entity, { ...query, page: 1, pageSize });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  return {
    list,
    items,
    total,
    isLoading: list.isLoading,
    ...(list.error ? { error: list.error } : {}),
    pageSize,
    hasMore: list.data !== undefined && total > items.length && pageSize < max,
    more: () => setPages((p) => p + 1),
    canRead: can("read", entity),
  };
}
