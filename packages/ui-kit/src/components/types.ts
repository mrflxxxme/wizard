// Prop types of the M0 components (ui-kit.yaml#components; names and shapes are normative).
import type { ReactNode } from "react";
import type { WzBase } from "../data/context.js";
import type { FileMimeType, ListQuery, Rec } from "../data/types.js";
import type { BadgeTone } from "./Badge.js";

export type Selection = Record<string, string[]>;

export type OptionGroup = {
  id: string;
  label: string;
  kind: "single" | "multi";
  required?: boolean;
  choices: { id: string; label: string; priceDelta?: number; disabled?: boolean }[];
};

export interface ItemCardData {
  id: string;
  title: string;
  description?: string;
  image?: string;
  price?: number | null;
  priceText?: string;
  remaining?: number | null;
  lowThreshold?: number;
  badge?: { text: string; tone: BadgeTone };
}

export interface ItemCardProps extends WzBase, ItemCardData {
  optionGroups?: OptionGroup[];
  selection?: Selection;
  onSelectionChange?(s: Selection): void;
  total?: number;
  ctaLabel?: string;
  onCta(): void;
  disabled?: boolean;
}

export interface CatalogProps<T = Rec> extends WzBase {
  entity: string;
  query?: Omit<ListQuery, "page">;
  map: (item: T) => ItemCardData;
  optionGroups?: OptionGroup[];
  onSelect: (item: T, selection: Selection) => void;
  columns?: 1 | 2 | 3 | "auto";
  emptyText?: string;
}

export interface RecordFormProps extends WzBase {
  entity: string;
  mode?: "create" | "edit";
  id?: string;
  fields?: string[];
  defaults?: Record<string, unknown>;
  hidden?: Record<string, unknown>;
  submitLabel?: string;
  onSuccess?(record: Rec): void;
  onCancel?(): void;
}

export type RecordAction<T = Rec> = {
  id: string;
  label: string;
  tone?: "primary" | "default" | "danger";
  /** ai (M3-02): runs the AI action `ai` of the spec on the record; filled fields get «заполнено ИИ». */
  kind: "update" | "delete" | "fn" | "link" | "ai";
  patch?: Record<string, unknown>;
  fn?: string;
  /** kind=fn: more arguments of the call besides the record's id (e.g. the target status of a status flow). */
  args?: Record<string, unknown>;
  /** kind=ai: aiActions[].name (runtime.yaml#ai_actions). */
  ai?: string;
  href?: string;
  confirm?: string;
  visible?(r: T): boolean;
};

export type ColumnDef<T = Rec> = {
  field: string;
  label?: string;
  render?(row: T): ReactNode;
  sortable?: boolean;
};

export interface DataTableProps<T = Rec> extends WzBase {
  entity: string;
  columns?: (string | ColumnDef<T>)[];
  query?: ListQuery;
  filters?: string[];
  searchable?: boolean;
  /** V3-18: «Выгрузить CSV» — every page under the current filter and search, only the role's visible fields. */
  exportCsv?: boolean;
  defaultSort?: { field: string; dir: "asc" | "desc" };
  pageSize?: 10 | 25 | 50;
  onRowClick?(row: T): void;
  rowActions?: RecordAction<T>[];
  emptyText?: string;
}

export interface RecordCardProps<T = Rec> extends WzBase {
  entity: string;
  id: string;
  fields?: string[];
  title?: string | ((r: T) => string);
  actions?: RecordAction<T>[];
  onDeleted?(): void;
}

export interface StatusBoardProps<T = Rec> extends WzBase {
  entity: string;
  statusField: string;
  columns?: string[];
  query?: ListQuery;
  card: (r: T) => { title: string; subtitle?: string; meta?: string };
  onCardClick?(r: T): void;
  limitPerColumn?: number;
}

export interface QrTicketProps extends WzBase {
  entity: string;
  id: string;
  tokenField: string;
  title: string;
  subtitle?: string;
  meta?: { label: string; value: string }[];
  hint?: string;
}

export type ScanResult = {
  status: "ok" | "duplicate" | "invalid" | "queued";
  ticketTitle?: string;
  details?: string;
  scannedAt: string;
  syncedAt?: string;
};

export interface QrScannerProps extends WzBase {
  checkpoint: string;
  verifyFn?: string;
  offline?: boolean;
  onResult?(r: ScanResult): void;
}

export interface CabinetLayoutProps extends WzBase {
  title?: string;
  sections: { id: string; label: string; content: ReactNode; count?: number }[];
  defaultSection?: string;
}

export type StatsData = {
  kpis: {
    id: string;
    label: string;
    value: number;
    total?: number;
    format?: "int" | "money" | "percent";
    hint?: string;
  }[];
  bars?: { title: string; items: { label: string; value: number; max: number }[] };
};

export interface StatsReportProps extends WzBase {
  title?: string;
  subtitle?: string;
  fn?: string;
  data?: StatsData;
}

/** A hint of the goal panel (B2-27): what happened, what to do and where (external — the platform, a new tab). */
export type GoalHint = {
  id: string;
  title: string;
  text: string;
  action: { label: string; href: string; external?: boolean };
};

/** ui-kit.yaml#components.GoalHints (B2-27). */
export interface GoalHintsProps extends WzBase {
  title?: string;
  subtitle?: string;
  items: GoalHint[];
  emptyText?: string;
}

/** ui-kit.yaml#components.FileField (M2-14). */
export interface FileFieldProps extends WzBase {
  name: string;
  label: string;
  /** fileId */
  value: string | null;
  onChange(fileId: string | null): void;
  accept?: FileMimeType[];
  required?: boolean;
  error?: string;
  /** ext: entity of the field for POST /api/files; default — the runtime finds it by the field name and role. */
  entity?: string;
  /** ext: no upload or removal (readonly fields of RecordForm). */
  disabled?: boolean;
}

export interface ConsentCheckboxProps extends WzBase {
  checked: boolean;
  onChange(checked: boolean): void;
  error?: string;
}
