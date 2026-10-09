// useMyRecords (V3-18, C4): a section of the client cabinet on a v3 page without markup — the logic of the v2 page /me
// of «Кабинет посетителя» (@wizard/modules visitorScreen): the visitor's own rows of an entity (the server applies the
// data modules' rowFilter by the login contact; nothing is filtered here), newest first, the fields the role reads as
// texts (enum labels, dates, money, the caption of a referenced record), and «Отменить» when the role may set the
// cancelled status itself.
import type { Field } from "@wizard/appspec";
import { useMemo, useState } from "react";
import { useCan, useDataSource, useRoleSpec, useWzUser } from "../../data/context.js";
import { titleField } from "../../data/roleSpec.js";
import type { Rec, WzError } from "../../data/types.js";
import { formatDate, formatDateTime, formatMoney, formatNumber, maskPhone } from "../../format.js";
import { LIST_PAGE, usePagedList } from "./list.js";

/** At most this many fields per row (the v2 cabinet's DataTable columns). */
export const MY_RECORDS_FIELDS = 6;

export interface UseMyRecordsOptions {
  /** Fields of a row in order (default: what the role reads, without images, files and json, ≤ 6). */
  fields?: readonly string[];
  /** The visitor cancels a record himself: the status field and its value (shown when the role may update it). */
  cancel?: { field: string; value: string };
  /** Rows per «Показать ещё» (default 24). */
  pageSize?: number;
}

/** One field of a row as the visitor reads it. */
export interface MyRecordCell {
  name: string;
  label: string;
  text: string;
}

export interface MyRecord {
  id: string;
  cells: MyRecordCell[];
  /** Label of the status (enum) when the entity has one: «Подтверждена», «Новая». */
  status?: string;
  /** «Отменить» may be offered: the role may update the status and the record is not cancelled yet. */
  canCancel: boolean;
}

export interface MyRecordsModel {
  /** The role may read the entity (signed in as the client). */
  canRead: boolean;
  items: MyRecord[];
  total: number;
  isLoading: boolean;
  error?: WzError;
  hasMore: boolean;
  more(): void;
  /** Sets the cancel value of a record; false — the server refused (cancelError says why). */
  cancel(id: string): Promise<boolean>;
  /** The record being cancelled now. */
  pending: string | null;
  cancelError: string | null;
}

const EMPTY = "—";
const SKIP: ReadonlySet<Field["type"]> = new Set(["image", "file", "json", "qr_token"]);

/** The text of a value by its field type (Intl formats of the ui-kit, the enum label, the caption of a reference). */
export function cellText(field: Field, value: unknown, refs?: ReadonlyMap<string, string>): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  switch (field.type) {
    case "enum":
      return field.enum?.find((o) => o.value === value)?.label ?? String(value);
    case "money":
      return typeof value === "number" ? formatMoney(value) : String(value);
    case "int":
    case "decimal":
      return typeof value === "number" ? formatNumber(value) : String(value);
    case "date":
      return formatDate(String(value));
    case "datetime":
      return formatDateTime(String(value));
    case "bool":
      return value ? "Да" : "Нет";
    case "ref":
      return refs?.get(String(value)) ?? EMPTY;
    default:
      return String(value);
  }
}

/** The visitor's own records of `entity` (the role's rowFilter on the server), newest first, as texts. */
export function useMyRecords(entity: string, o: UseMyRecordsOptions = {}): MyRecordsModel {
  const spec = useRoleSpec();
  const can = useCan();
  const ds = useDataSource();
  const e = spec.entities.find((x) => x.name === entity);
  const fields = useMemo(() => {
    const all = e?.fields ?? [];
    const named = o.fields ? o.fields.map((n) => all.find((f) => f.name === n)) : all;
    return named
      .filter((f): f is Field => !!f && !SKIP.has(f.type))
      .filter((f) => f.type !== "ref" || (f.ref && can("read", f.ref.entity)))
      .slice(0, MY_RECORDS_FIELDS);
  }, [e, o.fields, can]);
  const query = { sort: { field: "created_at", dir: "desc" as const } };
  const page = o.pageSize ?? LIST_PAGE;
  const list = usePagedList<Rec>(entity, query, { page });
  // Captions of the references (a service, a specialist): one list per referenced entity the role may read (two at
  // most); without one the hook asks the same list as above — one request.
  const [one, two] = [...new Set(fields.flatMap((f) => (f.type === "ref" && f.ref ? [f.ref.entity] : [])))];
  const first = usePagedList(one ?? entity, one ? {} : query, { page: one ? 96 : page });
  const second = usePagedList(two ?? entity, two ? {} : query, { page: two ? 96 : page });
  const refs = useMemo(() => {
    const out = new Map<string, Map<string, string>>();
    const add = (target: string | undefined, rows: readonly Rec[]) => {
      if (!target) return;
      const title = titleField(spec, target);
      out.set(target, new Map(rows.map((r) => [r.id, String((title && r[title]) ?? r.id)])));
    };
    add(one, first.items);
    add(two, second.items);
    return out;
  }, [one, two, first.items, second.items, spec]);
  const update = ds.useUpdate(entity);
  const [pending, setPending] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const status = o.cancel ? e?.fields.find((f) => f.name === o.cancel?.field) : undefined;
  const statusField = status ?? e?.fields.find((f) => f.name === "status" && f.type === "enum") ?? undefined;
  const mayCancel = !!o.cancel && !!status && can("update", entity, o.cancel.field);
  const items: MyRecord[] = list.items.map((r) => {
    const st = statusField ? r[statusField.name] : undefined;
    return {
      id: r.id,
      cells: fields.map((f) => ({
        name: f.name,
        label: f.label,
        text: cellText(f, r[f.name], f.ref ? refs.get(f.ref.entity) : undefined),
      })),
      ...(statusField && st != null ? { status: cellText(statusField, st) } : {}),
      canCancel: mayCancel && st !== o.cancel?.value,
    };
  });
  return {
    canRead: list.canRead,
    items,
    total: list.total,
    isLoading: list.isLoading,
    ...(list.error ? { error: list.error } : {}),
    hasMore: list.hasMore,
    more: list.more,
    pending,
    cancelError,
    cancel: async (id) => {
      if (!o.cancel || !mayCancel) return false;
      setPending(id);
      setCancelError(null);
      try {
        await update.mutate(id, { [o.cancel.field]: o.cancel.value });
        list.list.refetch();
        return true;
      } catch (err) {
        const message = (err as { message?: unknown } | null)?.message;
        setCancelError(
          typeof message === "string" && message ? message : "Не получилось отменить. Попробуйте ещё раз.",
        );
        return false;
      } finally {
        setPending(null);
      }
    },
  };
}

/** The visitor of the cabinet: signed in or not, the name to greet him by (a phone masked), signing out. */
export interface ClientSession {
  signedIn: boolean;
  isLoading: boolean;
  name: string | null;
  signOut(): Promise<void>;
}

const PHONE_LIKE = /^\+?[\d\s()-]{10,}$/;

/** The session of the client cabinet over the DataSource (the user of the WzProvider wins, as in AppShell). */
export function useClientSession(): ClientSession {
  const r = useWzUser();
  const name = r.user
    ? PHONE_LIKE.test(r.user.displayName)
      ? maskPhone(r.user.displayName)
      : r.user.displayName
    : null;
  return { signedIn: r.user !== null, isLoading: r.isLoading, name, signOut: () => r.logout() };
}
