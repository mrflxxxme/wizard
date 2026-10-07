// DataTable (ui-kit.yaml#components.DataTable): server-side sort/filter/search/pagination kept in the URL,
// columns ∩ visible fields of RoleSpec, cards on sm.
import type { Field } from "@wizard/appspec";
import { type KeyboardEvent, type ReactNode, useMemo } from "react";
import { cx, useDataSource, useLocation, useNavigate, useRoleSpec, useWzRoot } from "../data/context.js";
import { entityOf, titleField } from "../data/roleSpec.js";
import type { ListQuery, Rec } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import { ButtonImpl } from "./Button.js";
import styles from "./DataTable.module.css";
import { FieldValue } from "./FieldValue.js";
import { useCabinetLook } from "./look.js";
import { RecordActions } from "./RecordActions.js";
import { part } from "./root.js";
import { DataState } from "./States.js";
import type { ColumnDef, DataTableProps } from "./types.js";

const SYSTEM: Field[] = (["created_at", "updated_at"] as const).map((name) => ({
  name,
  label: ru.systemFields[name] ?? name,
  type: "datetime",
}));

type Col<T> = ColumnDef<T> & { meta: Field | undefined; label: string };

function isDev(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV !== "production";
}

export function DataTable<T = Rec>(props: DataTableProps<T>): ReactNode {
  const root = useWzRoot("DataTable", "wz-datatable", props);
  const look = useCabinetLook();
  const spec = useRoleSpec();
  const ds = useDataSource();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const ent = entityOf(spec, props.entity);
  const visible = [...(ent?.fields ?? []), ...SYSTEM];
  const byName = new Map(visible.map((f) => [f.name, f]));

  // Columns = requested ∩ visible fields of the role (hidden fields never render).
  const requested =
    props.columns ??
    (ent?.fields ?? [])
      .filter((f) => f.type !== "qr_token")
      .slice(0, 6)
      .map((f) => f.name);
  const cols: Col<T>[] = [];
  for (const c of requested) {
    const def: ColumnDef<T> = typeof c === "string" ? { field: c } : c;
    const meta = byName.get(def.field);
    if (!meta && !def.render) {
      if (isDev())
        console.warn(`[ui-kit] DataTable: column "${def.field}" is hidden for this role or unknown`);
      continue;
    }
    cols.push({ ...def, meta, label: def.label ?? meta?.label ?? def.field });
  }

  // URL state (?sort=&page=&f.<field>=&q=), prefixed by testId when several tables share a page.
  const prefix = props.testId ? `${props.testId}.` : "";
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const get = (k: string) => params.get(prefix + k);
  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(prefix + k);
      else next.set(prefix + k, v);
    }
    if (!("page" in patch)) next.delete(`${prefix}page`);
    const s = next.toString();
    navigate(`${pathname}${s ? `?${s}` : ""}`);
  };

  const sortParam = get("sort");
  const sort = sortParam
    ? {
        field: sortParam.replace(/^-/, ""),
        dir: sortParam.startsWith("-") ? ("desc" as const) : ("asc" as const),
      }
    : props.defaultSort;
  const page = Math.max(1, Number(get("page") ?? 1) || 1);
  const pageSize = props.pageSize ?? 25;
  const filterFields = (props.filters ?? []).filter((f) => byName.has(f));
  const filter: Record<string, unknown> = { ...(props.query?.filter ?? {}) };
  for (const f of filterFields) {
    const raw = get(`f.${f}`);
    if (raw === null) continue;
    const meta = byName.get(f);
    filter[f] = meta?.type === "bool" ? raw === "true" : raw;
  }
  const q = get("q") ?? "";
  const query: ListQuery = {
    ...props.query,
    filter,
    page,
    pageSize,
    ...(sort ? { sort } : {}),
    ...(props.searchable && q ? { search: q } : {}),
  };
  const list = ds.useList<T>(props.entity, query);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const onSort = (field: string) => {
    const dir = sort?.field === field && sort.dir === "asc" ? "desc" : "asc";
    setParams({ sort: dir === "desc" ? `-${field}` : field });
  };
  const rowKey = (e: KeyboardEvent, row: T) => {
    if (e.key === "Enter" && e.target === e.currentTarget) props.onRowClick?.(row);
  };
  const tid = (base: string) => (props.testId ? `${base}--${props.testId}` : base);

  const toolbar = (props.searchable || filterFields.length > 0) && (
    <div className={styles.toolbar}>
      {props.searchable && (
        <label className={styles.control}>
          <span className={styles.controlLabel}>{ru.dataTable.search}</span>
          <input
            type="search"
            className={styles.input}
            data-testid={tid("wz-datatable-search")}
            value={q}
            onChange={(e) => setParams({ q: e.target.value })}
          />
        </label>
      )}
      {filterFields.map((f) => (
        <FilterControl
          key={f}
          field={byName.get(f) as Field}
          value={get(`f.${f}`) ?? ""}
          testId={tid(`wz-datatable-filter-${f}`)}
          onChange={(v) => setParams({ [`f.${f}`]: v })}
        />
      ))}
    </div>
  );

  let body: ReactNode = (
    <DataState result={list} empty={list.data?.items.length === 0} emptyText={props.emptyText} lines={5} />
  );
  if (list.data && list.data.items.length > 0 && !list.error) {
    body = (
      <table className={styles.table}>
        <thead>
          <tr>
            {cols.map((c) => {
              const sortable = c.sortable ?? !!c.meta;
              const active = sort?.field === c.field;
              return (
                <th
                  key={c.field}
                  scope="col"
                  aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={styles.sort}
                      data-testid={tid(`wz-datatable-sort-${c.field}`)}
                      onClick={() => onSort(c.field)}
                      aria-label={ru.dataTable.sortBy(c.label)}
                    >
                      {c.label}
                      <span aria-hidden="true" className={styles.arrow}>
                        {active ? (sort?.dir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
            {props.rowActions?.length ? <th scope="col">{ru.dataTable.actions}</th> : null}
          </tr>
        </thead>
        <tbody>
          {list.data.items.map((row) => {
            const r = row as Rec;
            return (
              <tr
                key={r.id}
                data-testid={tid("wz-datatable-row")}
                className={cx(props.onRowClick && styles.clickable)}
                tabIndex={props.onRowClick ? 0 : undefined}
                onClick={props.onRowClick ? () => props.onRowClick?.(row) : undefined}
                onKeyDown={props.onRowClick ? (e) => rowKey(e, row) : undefined}
              >
                {cols.map((c) => (
                  <td key={c.field} data-label={c.label}>
                    {c.render ? c.render(row) : <FieldValue field={c.meta} value={r[c.field]} />}
                  </td>
                ))}
                {props.rowActions?.length ? (
                  <td data-label={ru.dataTable.actions}>
                    <RecordActions
                      entity={props.entity}
                      row={row}
                      actions={props.rowActions}
                      testPrefix={tid("wz-datatable-action")}
                      onDone={list.refetch}
                    />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <section
      {...root}
      {...look}
      className={cx(styles.wrap, props.className)}
      aria-busy={list.isLoading || undefined}
    >
      {toolbar}
      {body}
      {total > pageSize && (
        <nav className={styles.pager} aria-label={ru.dataTable.page(page, pages)}>
          <ButtonImpl
            root={part(tid("wz-datatable-page-prev"))}
            size="sm"
            disabled={page <= 1}
            onClick={() => setParams({ page: String(page - 1) })}
          >
            {ru.dataTable.prev}
          </ButtonImpl>
          <span className={styles.pageInfo}>{ru.dataTable.page(page, pages)}</span>
          <ButtonImpl
            root={part(tid("wz-datatable-page-next"))}
            size="sm"
            disabled={page >= pages}
            onClick={() => setParams({ page: String(page + 1) })}
          >
            {ru.dataTable.next}
          </ButtonImpl>
        </nav>
      )}
    </section>
  );
}

function FilterControl({
  field,
  value,
  testId,
  onChange,
}: {
  field: Field;
  value: string;
  testId: string;
  onChange(v: string): void;
}): ReactNode {
  let control: ReactNode;
  if (field.type === "date") {
    control = (
      <input
        type="date"
        className={styles.input}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    const options =
      field.type === "enum"
        ? (field.enum ?? [])
        : field.type === "bool"
          ? [
              { value: "true", label: ru.field.yes },
              { value: "false", label: ru.field.no },
            ]
          : null;
    control = options ? (
      <select
        className={styles.input}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{ru.dataTable.all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ) : field.type === "ref" && field.ref ? (
      <RefFilter target={field.ref.entity} testId={testId} value={value} onChange={onChange} />
    ) : null;
  }
  if (!control) return null;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control (input/select, possibly inside RefFilter) is nested
    <label className={styles.control}>
      <span className={styles.controlLabel}>{field.label}</span>
      {control}
    </label>
  );
}

function RefFilter({
  target,
  testId,
  value,
  onChange,
}: {
  target: string;
  testId: string;
  value: string;
  onChange(v: string): void;
}): ReactNode {
  const spec = useRoleSpec();
  const caption = titleField(spec, target);
  const list = useDataSource().useList<Rec>(target, { pageSize: 100 });
  return (
    <select
      className={styles.input}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{ru.dataTable.all}</option>
      {(list.data?.items ?? []).map((r) => (
        <option key={r.id} value={r.id}>
          {caption ? String(r[caption] ?? r.id) : r.id}
        </option>
      ))}
    </select>
  );
}
